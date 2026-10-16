// compliance.mjs — the filing calendar, generated from rules.
//
// A DATE WITHOUT ITS ARITHMETIC IS A GUESS. So an obligation carries the rule
// that produces its due date — 'day:7' is the seventh of the month after the
// period; 'days:150' is a hundred and fifty days after the year end — and this
// module expands rules into dated occurrences. Reading a generated date back
// to its rule is one lookup.
//
// Two dates per filing, not one: the paper deadline and the electronic one,
// which are different days and both worth seeing. A deadline landing on a
// weekend moves to the Monday. Public holidays move deadlines too and are not
// in this table; a due date falling next to one is worth checking against the
// Revenue Department's own calendar.

import { uid } from '../lib/ids.mjs'
import { nextWorkingDay as nextOpenDay } from './calendar.mjs'
import { post, accountByCode, PostingError } from './books.mjs'
import { jurisdictionFor } from '../lib/jurisdictions/index.mjs'

const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

export function addDaysStr(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
}

/** Saturday and Sunday push a deadline to the following Monday. */
export function nextWorkingDay(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay()
  if (dow === 6) return addDaysStr(dateStr, 2)
  if (dow === 0) return addDaysStr(dateStr, 1)
  return dateStr
}

/**
 * The due date for one period under one rule.
 * @param period 'YYYY-MM' | 'YYYY-H1' | 'YYYY-H2' | 'YYYY'
 */
export function dueDateFor(period, dueRule, { fiscalYearEnd = '12-31' } = {}) {
  const [kind, nStr] = String(dueRule).split(':')
  const n = Number(nStr)
  let endY
  let endM
  let endD
  if (/^\d{4}-\d{2}$/.test(period)) {
    endY = Number(period.slice(0, 4)); endM = Number(period.slice(5, 7))
    endD = lastDayOf(endY, endM)
  } else if (/^\d{4}-H[12]$/.test(period)) {
    endY = Number(period.slice(0, 4)); endM = period.endsWith('H1') ? 6 : 12
    endD = lastDayOf(endY, endM)
  } else {
    endY = Number(period.slice(0, 4))
    endM = Number(fiscalYearEnd.slice(0, 2)); endD = Number(fiscalYearEnd.slice(3, 5))
  }

  if (kind === 'day') {
    // The nth day of the month AFTER the period.
    const y = endM === 12 ? endY + 1 : endY
    const m = endM === 12 ? 1 : endM + 1
    return nextWorkingDay(iso(y, m, Math.min(n, lastDayOf(y, m))))
  }
  if (kind === 'days') {
    return nextWorkingDay(addDaysStr(iso(endY, endM, endD), n))
  }
  if (kind === 'months') {
    // The last day of the month n months after the period end.
    const total = endY * 12 + (endM - 1) + n
    const y = Math.floor(total / 12)
    const m = (total % 12) + 1
    return nextWorkingDay(iso(y, m, lastDayOf(y, m)))
  }
  throw new Error(`Unreadable due rule: ${dueRule}`)
}

/** The last day of a period, whatever shape the period string is. */
export function periodEnd(period, fiscalYearEnd = '12-31') {
  if (/^\d{4}-\d{2}$/.test(period)) {
    const y = Number(period.slice(0, 4))
    const m = Number(period.slice(5, 7))
    return iso(y, m, lastDayOf(y, m))
  }
  if (/^\d{4}-H[12]$/.test(period)) {
    const y = Number(period.slice(0, 4))
    const m = period.endsWith('H1') ? 6 : 12
    return iso(y, m, lastDayOf(y, m))
  }
  if (/^\d{4}-Q[1-4]$/.test(period)) {
    const y = Number(period.slice(0, 4))
    const m = Number(period.slice(6, 7)) * 3
    return iso(y, m, lastDayOf(y, m))
  }
  return `${period.slice(0, 4)}-${fiscalYearEnd}`
}

/** Does an obligation apply to this entity as it stands? */
export async function applies(db, entity, obligation, { asOf }) {
  switch (obligation.applies_when) {
    case 'vat_registered':
      return Boolean(entity.vat_registered) && (!entity.vat_from || entity.vat_from <= asOf)
    case 'company':
      return entity.kind === 'company'
    case 'sole':
      return entity.kind === 'sole'
    case 'has_employees': {
      const row = await db.get(
        `SELECT COUNT(*) AS n FROM employment
          WHERE entity_id = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)`,
        entity.id, asOf, asOf)
      return (row?.n ?? 0) > 0
    }
    case 'withholds': {
      const row = await db.get(
        `SELECT COUNT(*) AS n FROM payment p
          WHERE p.entity_id = ? AND p.direction = 'out' AND p.wht_amount > 0
            AND p.on_date <= ?`, entity.id, asOf)
      return (row?.n ?? 0) > 0
    }
    default:
      return true
  }
}

const periodsBetween = (frequency, from, to, fiscalYearEnd) => {
  const out = []
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  if (frequency === 'monthly') {
    for (let t = fy * 12 + (fm - 1); t <= ty * 12 + (tm - 1); t++) {
      out.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`)
    }
  } else if (frequency === 'quarterly') {
    for (let y = fy; y <= ty; y++) for (const q of [1, 2, 3, 4]) out.push(`${y}-Q${q}`)
  } else if (frequency === 'half_year') {
    for (let y = fy; y <= ty; y++) out.push(`${y}-H1`)
  } else if (frequency === 'annual') {
    for (let y = fy; y <= ty; y++) out.push(String(y))
  }
  return out
}

/**
 * Write the filings implied by an entity's obligations over a span. Existing
 * rows are left alone — including their status — so running this every month
 * adds what is new and touches nothing that has been filed.
 */
export async function generateFilings(db, entityId, { from, to }) {
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entityId)
  const obligations = await db.all(
    `SELECT * FROM obligation WHERE entity_id = ?
       AND (active_to IS NULL OR active_to >= ?) ORDER BY code`, entityId, from)
  const made = []
  for (const o of obligations) {
    for (const period of periodsBetween(o.frequency, from, to, entity.fiscal_year_end)) {
      // The rule gives the date; the calendar moves it off a day the offices
      // are shut. Weekends are arithmetic, holidays are rows.
      const ruleDate = dueDateFor(period, o.due_rule, { fiscalYearEnd: entity.fiscal_year_end })
      const due = await nextOpenDay(db, ruleDate, { entity_id: entityId })
      if (due < from || due > to) continue
      // Applicability is judged at the END OF THE PERIOD, not at the due
      // date: February's payroll return is owed by whoever had employees in
      // February, and hiring in March does not reach back.
      if (!(await applies(db, entity, o, {
        asOf: periodEnd(period, entity.fiscal_year_end),
      }))) continue
      const seen = await db.get(
        'SELECT id FROM filing WHERE obligation_id = ? AND period = ?', o.id, period)
      if (seen) continue
      const id = uid()
      await db.run(
        `INSERT INTO filing(id, obligation_id, entity_id, period, due_date, efile_date)
         VALUES (?,?,?,?,?,?)`,
        id, o.id, entityId, period, due,
        o.efile_bonus_days
          ? await nextOpenDay(db, addDaysStr(due, o.efile_bonus_days), { entity_id: entityId })
          : null)
      made.push(await db.get('SELECT * FROM filing WHERE id = ?', id))
    }
  }
  return made
}

/** What is owed on a filing, read from the accounts it draws on. */
export async function amountFor(db, entityId, code, period) {
  // A return covers what the business did in the month — not the journals that
  // file and pay it. Those land in whatever month the cheque was written, and
  // counting them here made filing August quietly reduce September's return.
  const monthWhere = "j.ym = ? AND j.source_kind NOT IN ('filing','filing_payment')"
  const q = async (sub, extra = '') => {
    const row = await db.get(
      `SELECT COALESCE(SUM(l.amount),0) AS total FROM journal_line l
         JOIN journal j ON j.id = l.journal_id
         JOIN account a ON a.id = l.account_id
        WHERE j.entity_id = ? AND ${monthWhere} AND a.subtype = ? ${extra}`,
      entityId, period, sub)
    return -(row?.total ?? 0)            // liabilities carry credit balances
  }
  switch (code) {
    case 'SSO': return q('sso')
    case 'PND1': {
      const a = await db.get(
        "SELECT id FROM account WHERE entity_id = ? AND code = '2210'", entityId)
      if (!a) return 0
      const row = await db.get(
        `SELECT COALESCE(SUM(l.amount),0) AS total FROM journal_line l
           JOIN journal j ON j.id = l.journal_id
          WHERE j.entity_id = ? AND j.ym = ? AND l.account_id = ?
            AND j.source_kind NOT IN ('filing','filing_payment')`, entityId, period, a.id)
      return -(row?.total ?? 0)
    }
    case 'PND3':
    case 'PND53': {
      const isCompany = code === 'PND53'
      const row = await db.get(
        `SELECT COALESCE(SUM(p.wht_amount),0) AS total FROM payment p
           JOIN party y ON y.id = p.party_id
          WHERE p.entity_id = ? AND p.direction = 'out'
            AND substr(p.on_date,1,7) = ? AND y.is_company = ?`,
        entityId, period, isCompany ? 1 : 0)
      return row?.total ?? 0
    }
    case 'PP30': {
      const out = await q('vat_out')
      const inp = await q('vat_in')
      return out + inp            // input VAT is a debit, so this is out less in
    }
    default: return null
  }
}

/** The calendar: what is due in a window, with what it comes to. */
export async function dueBetween(db, entityId, { from, to, includeFiled = false }) {
  const rows = await db.all(
    `SELECT f.*, o.code, o.name_en, o.name_th, o.name_km, o.authority, o.efile_bonus_days
       FROM filing f JOIN obligation o ON o.id = f.obligation_id
      WHERE f.entity_id = ? AND f.due_date BETWEEN ? AND ?
        ${includeFiled ? '' : "AND f.status IN ('due','prepared','late')"}
      ORDER BY f.due_date, o.code`, entityId, from, to)
  const out = []
  for (const r of rows) {
    const amount = r.amount ?? await amountFor(db, entityId, r.code, r.period)
    out.push({ ...r, amount })
  }
  return out
}

export async function markFiled(db, filingId, {
  filed_on, ref = null, amount = null, person_id = null, status = 'filed', settle = true,
}) {
  await db.run(
    `UPDATE filing SET status = ?, filed_on = ?, ref = ?, amount = COALESCE(?, amount),
       person_id = COALESCE(?, person_id) WHERE id = ?`,
    status, filed_on, ref, amount, person_id, filingId)
  // Filing is not only paperwork: the period stops being an open balance in
  // the control accounts and becomes one figure owed to one office.
  if (settle) await settleFiling(db, filingId, { on_date: filed_on, person_id })
  return db.get('SELECT * FROM filing WHERE id = ?', filingId)
}

// ---- what filing does to the books -----------------------------------------

/** The filing, its obligation code, and the entity it belongs to. */
async function filingContext(db, filingId) {
  const f = await db.get(
    `SELECT f.*, o.code, o.name_en, o.authority FROM filing f
       JOIN obligation o ON o.id = f.obligation_id WHERE f.id = ?`, filingId)
  if (!f) throw new PostingError('no_filing', 'No such filing.')
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', f.entity_id)
  const pack = jurisdictionFor(entity?.country || 'TH')
  return { filing: f, entity, rule: (pack.FILING_SETTLEMENT || {})[f.code] || null }
}

/** The account an office is owed through, made once if the chart lacks it. */
export async function payableAccount(db, entityId, code) {
  const seen = await accountByCode(db, entityId, code)
  if (seen) return seen
  await db.run(
    `INSERT INTO account(id, entity_id, code, name_en, name_th, name_km, type, subtype)
     VALUES (?,?,?,?,?,?,'liability','tax_pay')`,
    uid(), entityId, code, 'Tax payable', 'ภาษีค้างชำระ', 'ពន្ធត្រូវបង់')
  return accountByCode(db, entityId, code)
}

/**
 * Net a period out of its control accounts.
 *
 * Output VAT and input VAT are working accounts for a month, not running
 * totals: once the return is in, what remains is one figure owed to (or owed
 * by) the Revenue Department. This posts the difference and leaves the control
 * accounts flat for that period.
 *
 * It can be run again. What was already moved is subtracted, so a late invoice
 * added to a filed month moves only the difference — the earlier journal is
 * left alone, because it was true when it was posted.
 */
export async function settleFiling(db, filingId, { on_date = null, person_id = null } = {}) {
  const { filing, rule } = await filingContext(db, filingId)
  if (!rule?.nets?.length) return null            // nothing to net: it already has its liability
  const day = on_date || filing.filed_on || filing.due_date

  const accounts = await db.all(
    `SELECT * FROM account WHERE entity_id = ? AND subtype IN (${rule.nets.map(() => '?').join(',')})`,
    filing.entity_id, ...rule.nets)
  if (!accounts.length) return null

  const lines = []
  for (const a of accounts) {
    const raw = await db.get(
      `SELECT COALESCE(SUM(l.amount),0) AS n FROM journal_line l JOIN journal j ON j.id = l.journal_id
        WHERE j.entity_id = ? AND l.account_id = ? AND j.ym = ? AND j.source_kind <> 'filing'`,
      filing.entity_id, a.id, filing.period)
    const already = await db.get(
      `SELECT COALESCE(SUM(l.amount),0) AS n FROM journal_line l JOIN journal j ON j.id = l.journal_id
        WHERE l.account_id = ? AND j.source_kind = 'filing' AND j.source_id = ?`,
      a.id, filingId)
    const left = (raw?.n ?? 0) + (already?.n ?? 0)
    if (left) lines.push({ account: a.id, amount: -left })
  }
  if (!lines.length) return null

  const payable = await payableAccount(db, filing.entity_id, rule.payable)
  const net = lines.reduce((t, l) => t + l.amount, 0)
  const runs = await db.get(
    "SELECT COUNT(*) AS n FROM journal WHERE source_kind = 'filing' AND source_id = ?", filingId)

  const journal = await post(db, {
    entity_id: filing.entity_id,
    on_date: day,
    memo_en: `${filing.code} ${filing.period} — netted to what is owed`,
    source_kind: 'filing',
    source_id: filingId,
    idem_key: `filing:${filingId}:${runs?.n ?? 0}`,
    posted_by: person_id,
    lines: [...lines, { account: payable.id, amount: -net }],
  })
  await db.run(
    'UPDATE filing SET settled_journal_id = ?, amount = COALESCE(amount, ?) WHERE id = ?',
    journal.id, Math.abs(net), filingId)
  return journal
}

/**
 * Pay a return: the money leaves the bank on the day it leaves the bank.
 *
 * A separate act from filing, because it is a separate day and a separate line
 * on the statement — which is exactly what makes it matchable.
 */
export async function payFiling(db, filingId, {
  on_date, account = '1010', amount = null, person_id = null, ref = null,
}) {
  const { filing, rule } = await filingContext(db, filingId)
  if (!rule) throw new PostingError('no_rule', `Nothing is recorded about how ${filing.code} is paid.`)
  const cash = await accountByCode(db, filing.entity_id, account)
  if (!cash) throw new PostingError('no_account', `No account ${account} in these books.`)
  const payable = await payableAccount(db, filing.entity_id, rule.payable)

  const owed = amount ?? filing.amount ?? await amountFor(db, filing.entity_id, filing.code, filing.period)
  if (!owed) return null                           // a nil return costs nothing to pay

  const journal = await post(db, {
    entity_id: filing.entity_id,
    on_date,
    memo_en: `${filing.code} ${filing.period} paid${ref ? ` · ${ref}` : ''}`,
    source_kind: 'filing_payment',
    source_id: filingId,
    idem_key: `filingpay:${filingId}`,
    posted_by: person_id,
    lines: [
      { account: payable.id, amount: owed },       // the liability goes down
      { account: cash.id, amount: -owed },         // and the money goes out
    ],
  })
  await db.run(
    `UPDATE filing SET status = 'paid', paid_on = ?, paid_from = ?, payment_journal_id = ?,
       amount = COALESCE(amount, ?), ref = COALESCE(?, ref) WHERE id = ?`,
    on_date, account, journal.id, owed, ref, filingId)
  return journal
}

/**
 * What is owed to the offices right now, account by account.
 *
 * The whole point of the netting above is that this list is short and goes back
 * to nothing when it is paid, rather than being a number that only ever grows.
 */
export async function owedToOffices(db, entityId, { asOf = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10)
  const rows = await db.all(
    `SELECT a.code, a.name_en, a.name_th, a.name_km, a.subtype,
            COALESCE(SUM(l.amount),0) AS balance
       FROM account a
       LEFT JOIN journal_line l ON l.account_id = a.id
       LEFT JOIN journal j ON j.id = l.journal_id AND j.on_date <= ?
      WHERE a.entity_id = ? AND a.subtype IN ('tax_pay','wht_pay','sso','vat_out','vat_in')
      GROUP BY a.id ORDER BY a.code`, date, entityId)
  return rows
    .map((r) => ({ ...r, owed: -r.balance }))
    .filter((r) => r.owed !== 0)
}

/** Returns filed but not yet paid — what the next transfer to an office is. */
export const unpaidFilings = (db, entityId) => db.all(
  `SELECT f.*, o.code, o.name_en, o.name_th, o.name_km, o.authority
     FROM filing f JOIN obligation o ON o.id = f.obligation_id
    WHERE f.entity_id = ? AND f.status IN ('filed','late','due')
      AND f.paid_on IS NULL AND COALESCE(f.amount, 0) <> 0
    ORDER BY f.due_date`, entityId)

/** Anything past its date and not filed. Run before the calendar is read. */
export async function markLate(db, entityId, asOf) {
  const r = await db.run(
    `UPDATE filing SET status = 'late'
      WHERE entity_id = ? AND status = 'due' AND due_date < ?`, entityId, asOf)
  return r.changes
}
