// promptpay.mjs — build an EMVCo Merchant-Presented QR payload for PromptPay,
// and parse the mini-QR found on Thai bank transfer slips.
//
// The payload format is EMVCo's "QR Code Specification for Payment Systems"
// (MPM): a flat sequence of ID(2 digits) + LENGTH(2 digits) + VALUE, some of
// whose values are themselves nested TLV. Thailand's scheme lives under tag 29
// with Application Identifier A000000677010111.
//
// A payload built here is what the member's own banking app reads. Getting the
// CRC wrong means every bank in the country rejects the QR, so it is tested.

// ---- TLV primitives --------------------------------------------------------
/** id: 2-char string, value: string. Length is 2 decimal digits. */
export function tlv(id, value) {
  const v = String(value)
  if (v.length > 99) throw new Error(`promptpay: value too long for tag ${id}`)
  return `${id}${String(v.length).padStart(2, '0')}${v}`
}

/** Parse a flat EMVCo TLV string into [{id, value}] in document order. */
export function parseTlv(s) {
  const out = []
  let i = 0
  while (i + 4 <= s.length) {
    const id = s.slice(i, i + 2)
    const len = Number(s.slice(i + 2, i + 4))
    if (!Number.isInteger(len)) break
    const value = s.slice(i + 4, i + 4 + len)
    out.push({ id, value })
    i += 4 + len
  }
  return out
}

// ---- CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) -------------------------
export function crc16(str) {
  let crc = 0xffff
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

// ---- payee id normalisation ------------------------------------------------
/**
 * PromptPay accepts three payee id kinds, each with its own sub-tag under 29:
 *   01 mobile number   → 13 digits: 0066 + the 9 digits after the leading 0
 *   02 national/tax id → 13 digits as-is
 *   03 e-Wallet id     → 15 digits as-is
 * Returns { subTag, value, kind }.
 */
export function normalisePayee(id) {
  const digits = String(id).replace(/\D/g, '')
  if (digits.length === 13) return { subTag: '02', value: digits, kind: 'tax_id' }
  if (digits.length === 15) return { subTag: '03', value: digits, kind: 'ewallet' }
  if (digits.length === 10 && digits.startsWith('0')) {
    return { subTag: '01', value: '0066' + digits.slice(1), kind: 'mobile' }
  }
  if (digits.length === 11 && digits.startsWith('66')) {
    return { subTag: '01', value: '00' + digits, kind: 'mobile' }
  }
  if (digits.length === 9) return { subTag: '01', value: '0066' + digits, kind: 'mobile' }
  throw new Error(`promptpay: unrecognised payee id "${id}" (${digits.length} digits)`)
}

// ---- payload ---------------------------------------------------------------
const AID_PROMPTPAY = 'A000000677010111'

/**
 * Build a PromptPay payload string.
 * @param payeeId   club PromptPay id (mobile / tax id / e-wallet)
 * @param satang    amount in INTEGER satang. Omit/0 for an open-amount QR
 *                  (used on the public donation page: donor types the amount).
 * @param oneTime   true = "dynamic" QR, single use. We use one-time for
 *                  invoices (the amount is specific to one member) and
 *                  multi-use for a standing donation poster.
 */
export function promptPayPayload({ payeeId, satang = 0, oneTime = true, merchantName, merchantCity = 'Chiang Mai', ref } = {}) {
  if (!payeeId) throw new Error('promptpay: payeeId required')
  if (!Number.isInteger(satang) || satang < 0) throw new Error('promptpay: satang must be a non-negative integer')

  const payee = normalisePayee(payeeId)

  let p = ''
  p += tlv('00', '01')                              // payload format indicator
  p += tlv('01', oneTime ? '12' : '11')             // 11 = static, 12 = dynamic
  p += tlv('29', tlv('00', AID_PROMPTPAY) + tlv(payee.subTag, payee.value))
  p += tlv('53', '764')                             // currency: THB (ISO 4217)
  if (satang > 0) p += tlv('54', formatAmount(satang))
  p += tlv('58', 'TH')                              // country
  if (merchantName) p += tlv('59', ascii(merchantName).slice(0, 25))
  p += tlv('60', ascii(merchantCity).slice(0, 15))
  // Tag 62 = additional data. Sub-tag 01 is a bill number; most retail banking
  // apps display it, which gives the member a human-readable "what is this".
  if (ref) p += tlv('62', tlv('01', ascii(ref).slice(0, 25)))

  p += '6304'                                       // CRC tag + length, then...
  return p + crc16(p)                               // ...the CRC over everything before it
}

/** Amount as a plain decimal string with 2 places, from integer satang. */
export function formatAmount(satang) {
  const sign = satang < 0 ? '-' : ''
  const abs = Math.abs(satang)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** EMVCo fields are ASCII; Thai names must be transliterated or omitted rather
 *  than smuggled in as UTF-8, which some bank apps render as mojibake. */
function ascii(s) {
  return String(s).replace(/[^\x20-\x7E]/g, '').trim()
}

/** Verify a payload's own CRC. Used by tests and by the slip parser. */
export function verifyPayload(payload) {
  const idx = payload.lastIndexOf('6304')
  if (idx < 0 || idx !== payload.length - 8) return false
  return crc16(payload.slice(0, idx + 4)) === payload.slice(idx + 4).toUpperCase()
}

// ---- bank slip mini-QR -----------------------------------------------------
/**
 * Thai bank transfer slips carry a small QR whose payload is also EMVCo TLV,
 * under Application Identifier A000000677010112 ("slip verify"). The value we
 * want is the transaction reference, which is what lets us match a payment to
 * an invoice without the treasurer reading a screenshot.
 *
 * Layout in the wild:
 *   00 02 -> "000"  (version)
 *   01 03 -> sending bank code (3 digits)
 *   02 xx -> transaction ref  (the useful part)
 * Returns { ok, ref, bank, raw } — never throws, because this is fed by
 * whatever a member's phone happened to capture.
 */
export function parseSlipQr(text) {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, reason: 'empty', raw }
  const fields = parseTlv(raw)
  if (!fields.length) return { ok: false, reason: 'not_tlv', raw }
  const byId = Object.fromEntries(fields.map((f) => [f.id, f.value]))
  const ref = byId['02'] || byId['03'] || null
  const bank = byId['01'] || null
  if (!ref || ref.length < 8) return { ok: false, reason: 'no_ref', raw, bank }
  return { ok: true, ref, bank, raw }
}
