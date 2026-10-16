// be.mjs — dates and amounts in the reader's own script.
//
// Thai and Khmer both count Buddhist years and both write their own numerals,
// but they do not agree on when the year turns, so the Khmer side lives in
// km.mjs and this file hands off to it. Everything else here is Thai.
//
// BE = CE + 543. A Thai tax invoice dated 2569 and one dated 2026 are the same
// day, and writing the Gregorian year on a Thai-language document is the
// single most common way to make one look wrong to the person reading it.

import { formatDateKm, formatMonthKm, amountWordsKm } from './km.mjs'

export const BE_OFFSET = 543
export const toBE = (year) => Number(year) + BE_OFFSET
export const fromBE = (year) => Number(year) - BE_OFFSET

const MON_TH_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
const MON_TH_ABBR = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const MON_EN = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const MON_EN_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * '2026-09-18' → '18 กันยายน 2569' (th) or '18 September 2026' (en).
 *
 * `both` adds the other reckoning in brackets — '18 September 2026 (2569)' —
 * for anything a Thai office and a foreign reader look at together.
 */
export function formatDate(dateStr, locale = 'en', { abbr = false, both = false } = {}) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y || !m || !d) return String(dateStr)
  // Khmer counts its months and its years differently enough to live in its
  // own file; this hands over rather than growing a third branch here.
  if (locale === 'km') return formatDateKm(dateStr)
  if (locale === 'th') {
    const mon = abbr ? MON_TH_ABBR[m - 1] : MON_TH_FULL[m - 1]
    return `${d} ${mon} ${toBE(y)}${both ? ` (${y})` : ''}`
  }
  const mon = abbr ? MON_EN_ABBR[m - 1] : MON_EN[m - 1]
  return `${d} ${mon} ${y}${both ? ` (${toBE(y)})` : ''}`
}

/** Both years for a single year number: '2026 / 2569'. */
export const bothYears = (year, locale = 'en') =>
  locale === 'th' ? `${toBE(year)} / ${year}` : `${year} / ${toBE(year)}`

/** '2026-09' → 'กันยายน 2569' / 'September 2026', with both years on request. */
export function formatMonth(ym, locale = 'en', { abbr = false, both = false } = {}) {
  if (locale === 'km') return formatMonthKm(ym)
  const [y, m] = String(ym).split('-').map(Number)
  if (!y || !m) return String(ym)
  const name = locale === 'th'
    ? (abbr ? MON_TH_ABBR : MON_TH_FULL)[m - 1]
    : (abbr ? MON_EN_ABBR : MON_EN)[m - 1]
  const year = locale === 'th'
    ? `${toBE(y)}${both ? ` (${y})` : ''}`
    : `${y}${both ? ` (${toBE(y)})` : ''}`
  return `${name} ${year}`
}

const THAI_DIGITS = ['๐', '๑', '๒', '๓', '๔', '๕', '๖', '๗', '๘', '๙']
/** Thai numerals, for the rare document that asks for them. */
export const thaiDigits = (s) => String(s).replace(/\d/g, (c) => THAI_DIGITS[Number(c)])

const ONES = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า']
const PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน']

function thaiIntWords(n) {
  if (n === 0) return 'ศูนย์'
  if (n >= 1_000_000) {
    const m = Math.floor(n / 1_000_000)
    const rest = n % 1_000_000
    return thaiIntWords(m) + 'ล้าน' + (rest ? thaiIntWords(rest) : '')
  }
  const s = String(n)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const digit = Number(s[i])
    const place = s.length - i - 1
    if (digit === 0) continue
    if (place === 1 && digit === 1) out += PLACES[1]                 // สิบ, not หนึ่งสิบ
    else if (place === 1 && digit === 2) out += 'ยี่' + PLACES[1]     // ยี่สิบ
    else if (place === 0 && digit === 1 && s.length > 1) out += 'เอ็ด' // ...เอ็ด
    else out += ONES[digit] + PLACES[place]
  }
  return out
}

/**
 * Amount in Thai words — 'หนึ่งพันบาทถ้วน'. Thai receipts carry the amount in
 * words beside the figures, and ถ้วน ("exactly") is what closes an amount with
 * no satang.
 */
export function bahtText(satang) {
  const neg = satang < 0
  const abs = Math.abs(Math.trunc(satang))
  const baht = Math.floor(abs / 100)
  const st = abs % 100
  let out = thaiIntWords(baht) + 'บาท'
  out += st ? thaiIntWords(st) + 'สตางค์' : 'ถ้วน'
  return (neg ? 'ลบ' : '') + out
}

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen']
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
  'eighty', 'ninety']

function enWords(n) {
  if (n < 20) return EN_ONES[n]
  if (n < 100) return EN_TENS[Math.floor(n / 10)] + (n % 10 ? '-' + EN_ONES[n % 10] : '')
  if (n < 1000) return EN_ONES[Math.floor(n / 100)] + ' hundred' +
    (n % 100 ? ' and ' + enWords(n % 100) : '')
  for (const [limit, word] of [[1e9, 'billion'], [1e6, 'million'], [1000, 'thousand']]) {
    if (n >= limit) {
      const head = Math.floor(n / limit)
      const rest = n % limit
      return enWords(head) + ' ' + word + (rest ? ' ' + enWords(rest) : '')
    }
  }
  return String(n)
}

/** English amount in words, for the same line on the English face. */
export function amountText(minorUnits, ccy = 'THB') {
  const names = { THB: ['baht', 'satang'], USD: ['dollars', 'cents'], EUR: ['euro', 'cents'] }
  const [major, minor] = names[ccy] || ['units', 'subunits']
  const abs = Math.abs(Math.trunc(minorUnits))
  const whole = Math.floor(abs / 100)
  const frac = abs % 100
  const head = `${enWords(whole)} ${major}`
  const tail = frac ? ` and ${enWords(frac)} ${minor}` : ' only'
  return ((minorUnits < 0 ? 'minus ' : '') + head + tail).replace(/^./, (c) => c.toUpperCase())
}

/**
 * An amount in words, in whichever language the document is being read in.
 *
 * A document says its total twice — in figures and in words — because that is
 * what makes an altered figure obvious. Which words depends on the reader.
 */
export function amountInWords(amount, currency = 'THB', locale = 'en', { minor = null } = {}) {
  if (locale === 'km') return amountWordsKm(amount, currency, { minor })
  if (locale === 'th' && currency === 'THB') return bahtText(amount)
  return amountText(amount, currency)
}
