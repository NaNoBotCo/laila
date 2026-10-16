// table.mjs — reading a table somebody else made.
//
// The file that arrives is a spreadsheet exported by a bank, an accountant, or
// a person who has kept the office's books in Excel for nine years. It is
// comma-separated or tab-separated or semicolon-separated; it has a byte-order
// mark; the amounts carry ฿ and commas and sometimes brackets for a negative;
// the dates are 2569 because Thailand writes the Buddhist year; a column is
// called วันที่ or Date or DATE or "Transaction date".
//
// None of that is the person's mistake, and none of it should be a reason to
// retype four hundred rows. This reads what is there and says what it made of
// it, so anything it could not read is a row somebody looks at rather than a
// number that quietly became zero.

import { parse as parseMoney } from './money.mjs'
import { fromBE } from './be.mjs'

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

/** Thai numerals to Arabic, so ๑,๒๓๔ is a number like any other. */
export const arabicDigits = (s) =>
  String(s).replace(/[๐-๙]/g, (c) => String(THAI_DIGITS.indexOf(c)))

/**
 * Which separator this text uses.
 *
 * Counted across the first several lines rather than the first one, because a
 * bank statement opens with a title line that contains no separator at all —
 * and reading that line alone once turned a semicolon file into one long
 * column. The winner is the one that appears the same number of times on the
 * most lines: a real separator is regular, a comma inside a name is not.
 */
export function sniffDelimiter(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim()).slice(0, 12)
    .map((l) => l.replace(/"(?:[^"]|"")*"/g, ''))
  let best = ','
  let bestScore = 0
  for (const d of ['\t', ';', ',', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1).filter((n) => n > 0)
    if (!counts.length) continue
    const mode = counts.sort((a, b) =>
      counts.filter((c) => c === b).length - counts.filter((c) => c === a).length)[0]
    const score = counts.filter((c) => c === mode).length * mode
    if (score > bestScore) { bestScore = score; best = d }
  }
  return best
}

/** Rows of strings, quotes honoured, ragged rows kept as they are. */
export function readDelimited(text, delimiter = null) {
  const src = String(text).replace(/^﻿/, '')
  const d = delimiter || sniffDelimiter(src)
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') { quoted = true; continue }
    if (c === d) { row.push(field); field = ''; continue }
    if (c === '\r') continue
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''))
}

/**
 * A table with a header row, as objects.
 *
 * A bank statement often carries a page of preamble before the header — the
 * account number, the branch, the date it was printed — so the header is the
 * first row that looks like one rather than the first row in the file.
 */
export function readTable(text, { delimiter = null } = {}) {
  const rows = readDelimited(text, delimiter)
  if (!rows.length) return { headers: [], rows: [], skipped: 0 }
  let at = 0
  let best = -1
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const filled = rows[i].filter((c) => String(c).trim() !== '').length
    const numeric = rows[i].filter((c) => parseMoney(String(c).trim()) != null).length
    const score = filled - numeric * 2          // a header is words, not amounts
    if (filled > 1 && score > best) { best = score; at = i }
  }
  const headers = rows[at].map((h) => String(h).trim())
  const body = rows.slice(at + 1)
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])))
  return { headers, rows: body, skipped: at }
}

// ---- reading what is in a cell ---------------------------------------------

const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTHS_TH = ['ม.ค', 'ก.พ', 'มี.ค', 'เม.ย', 'พ.ค', 'มิ.ย', 'ก.ค', 'ส.ค', 'ก.ย', 'ต.ค', 'พ.ย', 'ธ.ค']
const MONTHS_TH_LONG = ['มกรา', 'กุมภา', 'มีนา', 'เมษา', 'พฤษภา', 'มิถุนา', 'กรกฎา', 'สิงหา', 'กันยา', 'ตุลา', 'พฤศจิกา', 'ธันวา']

const monthFrom = (word) => {
  const w = String(word).toLowerCase()
  const en = MONTHS_EN.findIndex((m) => w.startsWith(m))
  if (en >= 0) return en + 1
  const th = MONTHS_TH.findIndex((m) => word.startsWith(m))
  if (th >= 0) return th + 1
  const thl = MONTHS_TH_LONG.findIndex((m) => word.startsWith(m))
  return thl >= 0 ? thl + 1 : 0
}

const iso = (y, m, d) => {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null
  // A year past 2200 is the Buddhist era written plainly, which is what a Thai
  // spreadsheet holds; 68 is 2568 BE, which is 2025.
  let year = y
  if (year < 100) year += year > 50 ? (year > 60 ? 2400 : 1900) : 2000
  if (year > 2200) year = fromBE(year)
  if (year < 1900 || year > 2200) return null
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * A date from whatever the cell holds, or null.
 *
 * Day-first, because that is how it is written here and in every Thai bank
 * export; an unambiguous ISO date is read as itself.
 */
export function readDate(cell) {
  const s = arabicDigits(String(cell ?? '').trim())
  if (!s) return null
  const isoish = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (isoish) return iso(Number(isoish[1]), Number(isoish[2]), Number(isoish[3]))
  const dmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/)
  if (dmy) return iso(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))
  const worded = s.match(/^(\d{1,2})[\s-]*([^\s\d]+)[\s-]*(\d{2,4})/)
  if (worded) {
    const m = monthFrom(worded[2])
    if (m) return iso(Number(worded[3]), m, Number(worded[1]))
  }
  const enFirst = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (enFirst) {
    const m = monthFrom(enFirst[1])
    if (m) return iso(Number(enFirst[3]), m, Number(enFirst[2]))
  }
  return null
}

/**
 * An amount in minor units, or null. Brackets mean negative — every accounting
 * package writes a credit that way — and a trailing CR or DR says which side.
 */
export function readAmount(cell, ccy = 'THB') {
  let s = arabicDigits(String(cell ?? '').trim())
  if (!s) return null
  let sign = 1
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1) }
  const tail = s.match(/\b(CR|DR)\b\s*$/i)
  if (tail) {
    if (tail[1].toUpperCase() === 'CR') sign = -sign
    s = s.replace(/\b(CR|DR)\b\s*$/i, '')
  }
  if (/^-/.test(s.trim())) { sign = -sign; s = s.trim().slice(1) }
  const v = parseMoney(s.trim(), ccy)
  return v == null ? null : sign * v
}

/** True-ish in any of the spellings a spreadsheet uses, including Thai. */
export function readFlag(cell) {
  const s = String(cell ?? '').trim().toLowerCase()
  if (!s) return null
  if (['1', 'y', 'yes', 'true', 't', 'x', '✓', 'ใช่', 'มี'].includes(s)) return true
  if (['0', 'n', 'no', 'false', 'f', '-', 'ไม่', 'ไม่ใช่'].includes(s)) return false
  return null
}

// ---- guessing which column is which ----------------------------------------

/** Words that name a field, in the three languages a column heading arrives in. */
export const FIELD_WORDS = {
  date: ['date', 'วันที่', 'วัน', 'transaction date', 'posting date', 'issue date', 'ថ្ងៃ'],
  name: ['name', 'customer', 'client', 'supplier', 'contact', 'ชื่อ', 'ลูกค้า', 'ผู้ขาย', 'ឈ្មោះ'],
  name_local: ['name (thai)', 'thai name', 'ชื่อภาษาไทย', 'ชื่อไทย', 'name th', 'khmer name'],
  tax_id: ['tax id', 'taxid', 'tax number', 'vat number', 'เลขประจำตัวผู้เสียภาษี', 'เลขผู้เสียภาษี'],
  email: ['email', 'e-mail', 'อีเมล'],
  phone: ['phone', 'tel', 'mobile', 'โทร', 'เบอร์', 'โทรศัพท์'],
  address: ['address', 'ที่อยู่'],
  country: ['country', 'nationality', 'ประเทศ', 'สัญชาติ'],
  currency: ['currency', 'ccy', 'สกุลเงิน'],
  terms_days: ['terms', 'credit days', 'payment terms', 'เครดิต', 'จำนวนวัน'],
  number: ['invoice no', 'invoice number', 'number', 'doc no', 'document', 'ref', 'reference',
    'เลขที่', 'เลขที่ใบแจ้งหนี้', 'เลขที่เอกสาร'],
  amount: ['amount', 'total', 'gross', 'จำนวนเงิน', 'ยอด', 'ยอดเงิน', 'รวม', 'ចំនួន'],
  outstanding: ['outstanding', 'balance due', 'unpaid', 'remaining', 'คงค้าง', 'ยอดค้าง'],
  due_date: ['due', 'due date', 'ครบกำหนด', 'กำหนดชำระ'],
  description: ['description', 'details', 'particulars', 'memo', 'narrative', 'note',
    'รายการ', 'รายละเอียด', 'คำอธิบาย'],
  debit: ['debit', 'withdrawal', 'paid out', 'out', 'ถอน', 'เดบิต', 'จ่าย'],
  credit: ['credit', 'deposit', 'paid in', 'in', 'ฝาก', 'เครดิต', 'รับ'],
  balance: ['balance', 'running balance', 'คงเหลือ', 'ยอดคงเหลือ'],
  vat: ['vat', 'tax', 'ภาษีมูลค่าเพิ่ม', 'ภาษี'],
  wht: ['withholding', 'wht', 'หัก ณ ที่จ่าย', 'ภาษีหัก'],
  account: ['account', 'account no', 'code', 'บัญชี', 'เลขที่บัญชี'],
  channel: ['channel', 'type', 'ประเภท', 'ช่องทาง'],
}

const fold = (s) => String(s).toLowerCase().replace(/[_\-.()]/g, ' ').replace(/\s+/g, ' ').trim()

/** The best column for each field, by heading. Ties go to the earlier column. */
export function guessColumns(headers, fields = Object.keys(FIELD_WORDS)) {
  const taken = new Set()
  const out = {}
  for (const field of fields) {
    const words = FIELD_WORDS[field] || []
    let best = null
    let bestScore = 0
    headers.forEach((h, i) => {
      if (taken.has(i)) return
      const head = fold(h)
      if (!head) return
      for (const w of words) {
        const word = fold(w)
        const score = head === word ? 3 : (head.startsWith(word) || head.endsWith(word) ? 2
          : (head.includes(word) ? 1 : 0))
        if (score > bestScore) { bestScore = score; best = i }
      }
    })
    if (best != null) { out[field] = headers[best]; taken.add(best) }
  }
  return out
}
