// km.mjs — Khmer dates, numerals and amounts in words.
//
// Two things differ from the Thai side and both bite:
//
//   1. THE BUDDHIST YEAR TURNS IN APRIL, not on 1 January. A Cambodian date in
//      February 2026 is ព.ស. 2569; the same year in May is 2570. Adding 543 to
//      everything — the Thai rule — is wrong for eight months of the year.
//   2. Khmer script has no spaces between words and a stack of marks that take
//      no width of their own, so anything that pads or counts characters has to
//      skip them or every column after it walks left.
//
// Khmer New Year is 13–16 April, fixed in practice for this purpose. A date on
// the boundary is worth a native eye rather than a rule in code.

export const KHMER_NEW_YEAR = { month: 4, day: 14 }

/** Cambodian Buddhist Era for a date: CE + 543 before the New Year, +544 after. */
export function toKhmerBE(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y) return null
  const beforeNewYear = m < KHMER_NEW_YEAR.month ||
    (m === KHMER_NEW_YEAR.month && d < KHMER_NEW_YEAR.day)
  return y + (beforeNewYear ? 543 : 544)
}

const KM_DIGITS = ['០', '១', '២', '៣', '៤', '៥', '៦', '៧', '៨', '៩']

/** Khmer numerals — used on documents that ask for them, never in arithmetic. */
export const khmerDigits = (s) => String(s).replace(/\d/g, (c) => KM_DIGITS[Number(c)])

const MONTHS_KM = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា',
  'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ']

const DOW_KM = ['អាទិត្យ', 'ច័ន្ទ', 'អង្គារ', 'ពុធ', 'ព្រហស្បតិ៍', 'សុក្រ', 'សៅរ៍']

/** '2026-09-18' → '១៨ កញ្ញា ២០២៦'. Gregorian by default: Cambodian business
 *  paper is dated in the common era, and the Buddhist year is asked for by
 *  name when it is wanted. */
export function formatDateKm(dateStr, { be = false, digits = true } = {}) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y || !m || !d) return String(dateStr)
  const year = be ? toKhmerBE(dateStr) : y
  const text = `${d} ${MONTHS_KM[m - 1]} ${year}`
  return digits ? khmerDigits(text) : text
}

export function formatMonthKm(ym, { be = false, digits = true } = {}) {
  const [y, m] = String(ym).split('-').map(Number)
  if (!y || !m) return String(ym)
  const year = be ? toKhmerBE(`${ym}-15`) : y
  const text = `${MONTHS_KM[m - 1]} ${year}`
  return digits ? khmerDigits(text) : text
}

export function dayNameKm(dateStr) {
  const i = new Date(`${dateStr}T00:00:00Z`).getUTCDay()
  return `ថ្ងៃ${DOW_KM[i]}`
}

// ---- numbers in words -------------------------------------------------------
//
// Khmer counts in fives: six is ប្រាំមួយ, "five-one". Tens above twenty are
// borrowed from Thai-Sanskrit (សាមសិប, សែសិប …) while twenty itself is ម្ភៃ.
// Above a thousand the scale words are ម៉ឺន (ten thousand) and សែន (hundred
// thousand), which is why a million is មួយលាន and not "one thousand thousand".

const ONES_KM = ['', 'មួយ', 'ពីរ', 'បី', 'បួន', 'ប្រាំ',
  'ប្រាំមួយ', 'ប្រាំពីរ', 'ប្រាំបី', 'ប្រាំបួន']
const TENS_KM = ['', 'ដប់', 'ម្ភៃ', 'សាមសិប', 'សែសិប', 'ហាសិប',
  'ហុកសិប', 'ចិតសិប', 'ប៉ែតសិប', 'កៅសិប']

function underHundred(n) {
  if (n < 10) return ONES_KM[n]
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return TENS_KM[tens] + (ones ? ONES_KM[ones] : '')
}

function underThousand(n) {
  if (n < 100) return underHundred(n)
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  return `${ONES_KM[hundreds]}រយ` + (rest ? underHundred(rest) : '')
}

/** A whole number in Khmer words. */
export function khmerWords(n) {
  const num = Math.trunc(Math.abs(n))
  if (num === 0) return 'សូន្យ'
  const scales = [
    [1_000_000_000, 'ប៊ីលាន'],
    [1_000_000, 'លាន'],
    [100_000, 'សែន'],
    [10_000, 'ម៉ឺន'],
    [1_000, 'ពាន់'],
  ]
  let rest = num
  let out = ''
  for (const [value, word] of scales) {
    if (rest < value) continue
    const count = Math.floor(rest / value)
    rest %= value
    out += (value >= 1_000_000 ? khmerWords(count) : underThousand(count)) + word
  }
  if (rest) out += underThousand(rest)
  return (n < 0 ? 'ដក' : '') + out
}

/**
 * An amount in words for a Cambodian document.
 *
 * The riel is a whole unit here — a Cambodian invoice does not carry sen — so a
 * riel amount reads straight out. Dollars keep their cents, because an invoice
 * in dollars routinely has them, and a document in dollars is ordinary in
 * Phnom Penh.
 */
export function amountWordsKm(amount, currency = 'KHR', { minor = null } = {}) {
  const digits = minor ?? (currency === 'KHR' ? 0 : 2)
  const abs = Math.abs(Math.trunc(amount))
  const scale = 10 ** digits
  const whole = Math.floor(abs / scale)
  const frac = abs % scale
  const name = { KHR: 'រៀល', USD: 'ដុល្លារ', THB: 'បាត' }[currency] || currency
  const head = `${khmerWords(whole)}${name}`
  if (!digits) return head
  return frac ? `${head}${khmerWords(frac)}សេន` : `${head}គត់`
}
