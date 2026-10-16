// qr.mjs — QR Code encoder (ISO/IEC 18004), byte mode, versions 1–40.
//
// Why from scratch instead of an npm package or a QR web service:
//   1. The payload contains the club's PromptPay payee id and the exact amount
//      owed by a named member. That must not travel to a third-party image API.
//   2. It has to run unchanged in a Cloudflare Worker (no node-canvas, no
//      native deps) and in node:test.
//   3. Output is SVG — sharp on every phone, tiny, and printable for the
//      donation table at an event.
//
// Structure follows the standard reference decomposition: encode → error
// correction (Reed-Solomon over GF(2^8)) → interleave → place → mask → format.

// ---- specification tables --------------------------------------------------
// Indexed [ecl][version]; index 0 of the version axis is unused (-1).
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
]
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
]
/** Format-info bit pattern per EC level (NOT the array index). */
const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 }
const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 }

const MIN_VERSION = 1
const MAX_VERSION = 40

// ---- capacity math ---------------------------------------------------------
/** Total data+ecc modules available for codewords at this version. */
function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}
/** Data codewords (i.e. excluding error correction) at this version + level. */
function numDataCodewords(ver, ecl) {
  const i = ECL_INDEX[ecl]
  return Math.floor(numRawDataModules(ver) / 8)
    - ECC_CODEWORDS_PER_BLOCK[i][ver] * NUM_ERROR_CORRECTION_BLOCKS[i][ver]
}

function alignmentPatternPositions(ver) {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// ---- Reed-Solomon over GF(2^8), primitive polynomial 0x11D -----------------
function gfMultiply(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}
/** Generator polynomial of degree `degree`, coefficients high-to-low, monic
 *  leading term omitted. */
function rsDivisor(degree) {
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}
function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length)
  for (const b of data) {
    const factor = b ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let i = 0; i < result.length; i++) result[i] ^= gfMultiply(divisor[i], factor)
  }
  return Array.from(result)
}

// ---- bit buffer ------------------------------------------------------------
function appendBits(bb, val, len) {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1)
}

/** Encode a string as byte-mode segment bits. UTF-8, as the QR spec's ECI-less
 *  default is ISO-8859-1 but every scanner in Thailand reads UTF-8 and
 *  PromptPay payloads are ASCII anyway. */
function byteModeBits(bytes, ver) {
  const bb = []
  appendBits(bb, 0b0100, 4)                       // mode indicator: byte
  appendBits(bb, bytes.length, ver <= 9 ? 8 : 16) // character count indicator
  for (const b of bytes) appendBits(bb, b, 8)
  return bb
}

function toBytes(str) {
  return Array.from(new TextEncoder().encode(str))
}

// ---- codewords -------------------------------------------------------------
function makeCodewords(text, ecl, minVersion) {
  const bytes = toBytes(text)
  let ver = minVersion
  let bits
  for (; ver <= MAX_VERSION; ver++) {
    bits = byteModeBits(bytes, ver)
    if (bits.length <= numDataCodewords(ver, ecl) * 8) break
  }
  if (ver > MAX_VERSION) throw new Error('qr: data too long for any version')

  const capacityBits = numDataCodewords(ver, ecl) * 8
  // terminator, then pad to a byte boundary, then alternating pad codewords
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length))
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8)

  const data = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    data.push(b)
  }
  return { ver, data }
}

/** Split into blocks, append RS parity to each, then interleave per spec. */
function addEccAndInterleave(data, ver, ecl) {
  const i = ECL_INDEX[ecl]
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[i][ver]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[i][ver]
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const blocks = []
  const div = rsDivisor(blockEccLen)
  for (let b = 0, k = 0; b < numBlocks; b++) {
    const len = shortBlockLen - blockEccLen + (b < numShortBlocks ? 0 : 1)
    const dat = data.slice(k, k + len)
    k += len
    const ecc = rsRemainder(dat, div)
    // short blocks get a placeholder byte so the interleave loop is uniform;
    // the placeholder is skipped when reading back out, below.
    if (b < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(ecc))
  }

  const result = []
  for (let idx = 0; idx < blocks[0].length; idx++) {
    for (let b = 0; b < blocks.length; b++) {
      if (idx !== shortBlockLen - blockEccLen || b >= numShortBlocks) result.push(blocks[b][idx])
    }
  }
  return result
}

// ---- matrix ----------------------------------------------------------------
function newGrid(size, fill) {
  return Array.from({ length: size }, () => new Array(size).fill(fill))
}

function drawFinder(modules, isFn, size, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      const x = cx + dx, y = cy + dy
      if (x >= 0 && x < size && y >= 0 && y < size) {
        modules[y][x] = dist !== 2 && dist !== 4
        isFn[y][x] = true
      }
    }
  }
}
function drawAlignment(modules, isFn, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      modules[cy + dy][cx + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
      isFn[cy + dy][cx + dx] = true
    }
  }
}

function drawFormatBits(modules, isFn, ecl, mask) {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const size = modules.length
  const set = (x, y, v) => { modules[y][x] = v; isFn[y][x] = true }
  const bit = (i) => ((bits >>> i) & 1) !== 0

  // copy 1 — around the top-left finder
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6))
  set(8, 8, bit(7))
  set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))

  // copy 2 — split across top-right and bottom-left
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
  set(8, size - 8, true) // the always-dark module
}

function drawVersionBits(modules, isFn, ver) {
  if (ver < 7) return
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (ver << 12) | rem
  const size = modules.length
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    modules[b][a] = bit; isFn[b][a] = true
    modules[a][b] = bit; isFn[a][b] = true
  }
}

function drawFunctionPatterns(modules, isFn, ver, ecl) {
  const size = modules.length
  // timing patterns
  for (let i = 0; i < size; i++) {
    modules[6][i] = i % 2 === 0; isFn[6][i] = true
    modules[i][6] = i % 2 === 0; isFn[i][6] = true
  }
  // finders + separators
  drawFinder(modules, isFn, size, 3, 3)
  drawFinder(modules, isFn, size, size - 4, 3)
  drawFinder(modules, isFn, size, 3, size - 4)
  // alignment patterns, skipping the three that collide with finders
  const pos = alignmentPatternPositions(ver)
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1)
        || (i === pos.length - 1 && j === 0)
      if (!corner) drawAlignment(modules, isFn, pos[i], pos[j])
    }
  }
  drawFormatBits(modules, isFn, ecl, 0) // placeholder; redrawn with real mask
  drawVersionBits(modules, isFn, ver)
}

function drawCodewords(modules, isFn, data) {
  const size = modules.length
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFn[y][x] && i < data.length * 8) {
          modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
          i++
        }
      }
    }
  }
}

const MASK_FN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]
function applyMask(modules, isFn, mask) {
  const size = modules.length
  const fn = MASK_FN[mask]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFn[y][x] && fn(x, y)) modules[y][x] = !modules[y][x]
    }
  }
}

// ---- mask penalty ----------------------------------------------------------
// The four rules from the spec. Penalty only decides WHICH mask is chosen —
// every mask yields a valid, decodable symbol — but choosing well is what makes
// a QR lock on instantly under a coffee-shop light instead of after three tries.

const N1 = 3, N2 = 3, N3 = 40, N4 = 10

/** Slide a run length into the 7-slot history. The first run of a line gets the
 *  quiet zone added, since the border is light and counts toward the ratio. */
function addRunToHistory(runLen, history, size) {
  if (history[0] === 0) runLen += size // implicit light quiet-zone border
  history.pop()
  history.unshift(runLen)
}

/** Count 1:1:3:1:1 finder-lookalike patterns with 4+ light modules on a side. */
function countFinderLike(h) {
  const n = h[1]
  const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n
  return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0)
    + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0)
}

function terminateAndCount(runColor, runLen, history, size) {
  if (runColor) { // a dark run can't be the terminal light run; flush it first
    addRunToHistory(runLen, history, size)
    runLen = 0
  }
  runLen += size // trailing quiet zone
  addRunToHistory(runLen, history, size)
  return countFinderLike(history)
}

function penaltyScore(modules) {
  const size = modules.length
  let result = 0

  // rules 1 and 3, scored in one pass over rows then columns
  for (const transposed of [false, true]) {
    for (let a = 0; a < size; a++) {
      let runColor = false, runLen = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let b = 0; b < size; b++) {
        const color = transposed ? modules[b][a] : modules[a][b]
        if (color === runColor) {
          runLen++
          if (runLen === 5) result += N1
          else if (runLen > 5) result++
        } else {
          addRunToHistory(runLen, history, size)
          if (!runColor) result += countFinderLike(history) * N3
          runColor = color
          runLen = 1
        }
      }
      result += terminateAndCount(runColor, runLen, history, size) * N3
    }
  }

  // rule 2 — solid 2x2 blocks
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x]
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += N2
      }
    }
  }

  // rule 4 — deviation from 50% dark, in 5% steps
  let dark = 0
  for (const row of modules) for (const c of row) if (c) dark++
  const total = size * size
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  result += k * N4
  return result
}

// ---- public API ------------------------------------------------------------
/**
 * Encode text into a QR symbol.
 * @returns {{size:number, version:number, modules:boolean[][]}}
 */
export function encodeQr(text, { ecl = 'M', minVersion = MIN_VERSION } = {}) {
  if (!(ecl in ECL_INDEX)) throw new Error('qr: bad ec level ' + ecl)
  const { ver, data } = makeCodewords(text, ecl, Math.max(MIN_VERSION, minVersion))
  const allCodewords = addEccAndInterleave(data, ver, ecl)

  const size = ver * 4 + 17
  const modules = newGrid(size, false)
  const isFn = newGrid(size, false)
  drawFunctionPatterns(modules, isFn, ver, ecl)
  drawCodewords(modules, isFn, allCodewords)

  // choose the mask with the lowest penalty
  let bestMask = 0, bestPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFn, mask)
    drawFormatBits(modules, isFn, ecl, mask)
    const p = penaltyScore(modules)
    if (p < bestPenalty) { bestPenalty = p; bestMask = mask }
    applyMask(modules, isFn, mask) // undo (XOR is its own inverse)
  }
  applyMask(modules, isFn, bestMask)
  drawFormatBits(modules, isFn, ecl, bestMask)

  return { size, version: ver, mask: bestMask, modules }
}

/**
 * Render a QR symbol as a standalone SVG string.
 * @param border quiet zone in modules — the spec requires 4; never go below it
 *        or half the banking apps in Thailand will fail to lock on.
 */
export function qrToSvg(text, { ecl = 'M', border = 4, scale = 8, dark = '#111', light = '#fff', title = 'QR' } = {}) {
  const { size, modules } = encodeQr(text, { ecl })
  const dim = (size + border * 2) * scale
  let path = ''
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) path += `M${(x + border) * scale},${(y + border) * scale}h${scale}v${scale}h-${scale}z`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" role="img" aria-label="${title.replace(/[<>&"]/g, '')}">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
    + `<path d="${path}" fill="${dark}"/></svg>`
}

/** Monochrome PBM (P4) — trivial format, handy for piping into decoders in
 *  tests and for thermal receipt printers at events. */
export function qrToPbm(text, { ecl = 'M', border = 4, scale = 4 } = {}) {
  const { size, modules } = encodeQr(text, { ecl })
  const dim = (size + border * 2) * scale
  const rowBytes = Math.ceil(dim / 8)
  const header = Buffer.from(`P4\n${dim} ${dim}\n`, 'ascii')
  const body = Buffer.alloc(rowBytes * dim, 0)
  for (let y = 0; y < dim; y++) {
    const my = Math.floor(y / scale) - border
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - border
      const on = my >= 0 && my < size && mx >= 0 && mx < size && modules[my][mx]
      if (on) body[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return Buffer.concat([header, body])
}
