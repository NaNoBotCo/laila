// money.mjs — integer minor units, several currencies, and rounding that is
// decided rather than inherited.
//
// THE RULE: an amount is an INTEGER in the currency's minor unit. ฿1,234.50 is
// 123450 satang. $10 is 1000 cents. A float never holds an amount, and a
// division always says what it does with the remainder.

export const CURRENCIES = {
  THB: { symbol: '฿', minor: 2, name_en: 'Thai baht', name_th: 'บาท' },
  USD: { symbol: '$', minor: 2, name_en: 'US dollar', name_th: 'ดอลลาร์สหรัฐ' },
  EUR: { symbol: '€', minor: 2, name_en: 'Euro', name_th: 'ยูโร' },
  GBP: { symbol: '£', minor: 2, name_en: 'Pound sterling', name_th: 'ปอนด์' },
  JPY: { symbol: '¥', minor: 0, name_en: 'Japanese yen', name_th: 'เยน' },
  // The riel has a sen in law and none in use: prices, invoices and tax returns
  // are all whole riel, so the minor unit is the riel itself.
  KHR: { symbol: '៛', minor: 0, name_en: 'Cambodian riel', name_th: 'เรียล', name_km: 'រៀល' },
}

export const minorFactor = (ccy) => 10 ** (CURRENCIES[ccy]?.minor ?? 2)

/** 123450, 'THB' → "฿1,234.50". `plain` drops the symbol, for CSV. */
export function format(amount, ccy = 'THB', { plain = false } = {}) {
  const def = CURRENCIES[ccy] || CURRENCIES.THB
  const n = Math.trunc(Number(amount) || 0)
  const neg = n < 0
  const abs = Math.abs(n)
  const f = 10 ** def.minor
  const whole = String(Math.floor(abs / f)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = def.minor ? '.' + String(abs % f).padStart(def.minor, '0') : ''
  const body = `${whole}${frac}`
  return `${neg ? '-' : ''}${plain ? '' : def.symbol}${body}`
}

/**
 * Parse a typed amount into minor units. Returns null on anything it cannot
 * read exactly — a bad string must not become zero, because a silent ฿0 is the
 * one error nobody sees until the bank does.
 */
export function parse(input, ccy = 'THB') {
  if (input == null) return null
  const minor = CURRENCIES[ccy]?.minor ?? 2
  const s = String(input).trim().replace(/[฿$€£¥,\s]/g, '')
  const re = minor ? new RegExp(`^-?\\d+(\\.\\d{1,${minor}})?$`) : /^-?\d+$/
  if (!re.test(s)) return null
  const neg = s.startsWith('-')
  const [whole, frac = ''] = s.replace('-', '').split('.')
  const v = Number(whole) * 10 ** minor + (minor ? Number(frac.padEnd(minor, '0')) : 0)
  if (!Number.isSafeInteger(v)) return null
  return neg ? -v : v
}

/** Percentage in basis points, rounded half away from zero. 10000 bp = 100%. */
export function pct(amount, bp) {
  const v = (Math.abs(amount) * bp) / 10000
  const r = Math.round(v)
  return amount < 0 ? -r : r
}

/** Round to the nearest whole major unit (฿1), half up. Thai tax forms and
 *  most price lists are written in whole baht. */
export function toWhole(amount, ccy = 'THB') {
  const f = minorFactor(ccy)
  return Math.round(amount / f) * f
}

/**
 * Split an amount into shares by weight with NOTHING lost. The largest
 * remainder takes the odd minor units, so the parts always add back to the
 * whole — the failure this replaces is three 33.33% shares of ฿100 adding to
 * ฿99.99 and a partner statement that does not balance.
 */
export function splitByWeights(amount, weights) {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return weights.map(() => 0)
  const raw = weights.map((w) => (amount * w) / total)
  const base = raw.map((r) => Math.trunc(r))
  let left = amount - base.reduce((a, b) => a + b, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.trunc(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const step = left < 0 ? -1 : 1
  for (let k = 0; left !== 0; k++) {
    base[order[k % order.length].i] += step
    left -= step
  }
  return base
}

/** Convert with an integer rate in parts per million, so no float is stored.
 *  1 USD = 36.25 THB → rate_ppm 36_250_000. */
export function convert(amount, ratePpm, { fromMinor = 2, toMinor = 2 } = {}) {
  const scaled = (amount * ratePpm) / 1_000_000
  const adjusted = scaled * 10 ** (toMinor - fromMinor)
  return Math.round(adjusted)
}

export const ratePpm = (rate) => Math.round(rate * 1_000_000)

/**
 * Walk a ladder of bands. Each band is { upTo, bp } — the top of the band and
 * the rate charged inside it. Income tax is charged this way in both countries
 * this system keeps books in; only the ladders differ.
 */
export function onBands(amount, bands) {
  let remaining = Math.max(0, amount)
  let last = 0
  let total = 0
  for (const band of bands) {
    const slice = Math.min(remaining, band.upTo - last)
    if (slice <= 0) break
    total += pct(slice, band.bp)
    remaining -= slice
    last = band.upTo
  }
  return total
}

/** VAT out of a price that already includes it: 107 gross at 700 bp → 7 VAT. */
export function vatFromGross(gross, bp) {
  return Math.round((gross * bp) / (10000 + bp))
}
