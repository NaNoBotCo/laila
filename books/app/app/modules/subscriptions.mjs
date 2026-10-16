// subscriptions.mjs — seats and retainers, billed by period.
//
// The rule the whole module exists to keep: ONE INVOICE PER PERIOD PER
// SUBSCRIPTION. `billed_period` holds that as a unique constraint, so a
// billing run that dies half way can be run again and finishes instead of
// double-billing. Everything else here is date arithmetic.
//
// The anchor day is kept rather than derived: a subscription that starts on
// the 31st bills on the 30th in April and back on the 31st in May, which is
// what a customer expects and what a naive "add one month" gets wrong.

import { uid } from '../lib/ids.mjs'
import { draft, issue } from './documents.mjs'

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** Add months to a date string, clamping the day to the target month's end. */
export function addMonths(dateStr, n, anchorDay = null) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const total = (y * 12 + (m - 1)) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const want = anchorDay || d
  const day = Math.min(want, daysInMonth(ny, nm))
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const STEP = { month: 1, quarter: 3, year: 12 }

/** The span a bill starting on `from` covers, and the day the next one starts. */
export function periodFor(from, interval, anchorDay = null) {
  if (interval === 'once') return { from_date: from, to_date: from, next: null }
  const next = addMonths(from, STEP[interval] ?? 1, anchorDay)
  const to = new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
  return { from_date: from, to_date: to, next }
}

export async function addPlan(db, { entity_id, project_id = null, code, name_en, name_th = null, name_km = null,
  price = 0, currency = null, interval = 'month', tax_code = 'NONE', account_id = null, note = null }) {
  const seen = await db.get('SELECT * FROM plan WHERE entity_id = ? AND code = ?', entity_id, code)
  if (seen) return seen
  const books = await db.get('SELECT currency FROM entity WHERE id = ?', entity_id)
  const id = uid()
  await db.run(
    `INSERT INTO plan(id, entity_id, project_id, code, name_en, name_th, name_km, price,
       currency, interval, tax_code, account_id, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, project_id, code, name_en, name_th, name_km, price,
    currency || books?.currency || 'THB', interval,
    tax_code, account_id, note)
  return db.get('SELECT * FROM plan WHERE id = ?', id)
}

export async function subscribe(db, {
  entity_id, party_id, plan_id, seats = 1, price_override = null, currency = null,
  start_date, end_date = null, anchor_day = null, po_ref = null, note = null,
}) {
  const id = uid()
  const day = anchor_day || Number(start_date.slice(8, 10))
  await db.run(
    `INSERT INTO subscription(id, entity_id, party_id, plan_id, seats, price_override,
       currency, start_date, end_date, next_bill_on, anchor_day, po_ref, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, party_id, plan_id, seats, price_override, currency,
    start_date, end_date, start_date, day, po_ref, note)
  return db.get('SELECT * FROM subscription WHERE id = ?', id)
}

export async function changeSeats(db, subscriptionId, seats) {
  await db.run('UPDATE subscription SET seats = ? WHERE id = ?', seats, subscriptionId)
  return db.get('SELECT * FROM subscription WHERE id = ?', subscriptionId)
}

/** Stop at the end of the paid period, or on a date. */
export async function cancel(db, subscriptionId, { on_date = null, at_period_end = true } = {}) {
  if (at_period_end) {
    await db.run('UPDATE subscription SET cancel_at_end = 1 WHERE id = ?', subscriptionId)
  } else {
    await db.run(
      "UPDATE subscription SET status = 'cancelled', end_date = ? WHERE id = ?",
      on_date, subscriptionId)
  }
  return db.get('SELECT * FROM subscription WHERE id = ?', subscriptionId)
}

export async function dueOn(db, entityId, asOf) {
  return db.all(
    `SELECT s.*, p.code AS plan_code, p.name_en AS plan_name_en, p.name_th AS plan_name_th,
            p.name_km AS plan_name_km,
            p.price AS plan_price, p.currency AS plan_currency, p.interval,
            p.tax_code, p.account_id, p.project_id
       FROM subscription s JOIN plan p ON p.id = s.plan_id
      WHERE s.entity_id = ? AND s.status = 'active'
        AND s.next_bill_on IS NOT NULL AND s.next_bill_on <= ?
      ORDER BY s.next_bill_on`, entityId, asOf)
}

/**
 * Bill everything due on or before a date.
 *
 * Idempotent twice over: the period row refuses a second bill for the same
 * span, and the invoice itself carries an idempotency key built from the
 * subscription and the period. Running this every morning is safe.
 */
export async function runBilling(db, entityId, { asOf, posted_by = null, issue_docs = true } = {}) {
  const due = await dueOn(db, entityId, asOf)
  const made = []
  for (const s of due) {
    const span = periodFor(s.next_bill_on, s.interval, s.anchor_day)
    const seen = await db.get(
      'SELECT * FROM billed_period WHERE subscription_id = ? AND from_date = ?',
      s.id, span.from_date)
    if (seen) {
      await advance(db, s, span)
      continue
    }
    const unit = s.price_override ?? s.plan_price
    const amount = unit * s.seats
    const key = `sub:${s.id}:${span.from_date}`
    // Billed in advance, but payable on the customer's own terms — an invoice
    // raised on the first of the month is not overdue on the first.
    const terms = (await db.get('SELECT terms_days FROM party WHERE id = ?', s.party_id))?.terms_days ?? 0
    const doc = await draft(db, {
      entity_id: entityId,
      kind: 'invoice',
      party_id: s.party_id,
      project_id: s.project_id,
      issue_date: span.from_date,
      due_date: terms
        ? new Date(Date.parse(`${span.from_date}T00:00:00Z`) + terms * 86400000)
          .toISOString().slice(0, 10)
        : span.from_date,
      currency: s.currency || s.plan_currency,
      idem_key: key,
      subject_en: `${s.plan_name_en} — ${span.from_date} to ${span.to_date}`,
      subject_th: s.plan_name_th
        ? `${s.plan_name_th} — ${span.from_date} ถึง ${span.to_date}` : null,
      subject_km: s.plan_name_km
        ? `${s.plan_name_km} — ${span.from_date} ដល់ ${span.to_date}` : null,
      lines: [{
        desc_en: `${s.plan_name_en} × ${s.seats}`,
        desc_th: s.plan_name_th ? `${s.plan_name_th} × ${s.seats}` : null,
        desc_km: s.plan_name_km ? `${s.plan_name_km} × ${s.seats}` : null,
        qty_milli: s.seats * 1000,
        unit: 'seat',
        unit_price: unit,
        tax_code: s.tax_code,
        account_id: s.account_id,
        project_id: s.project_id,
      }],
    })
    const finished = issue_docs && doc.status === 'draft'
      ? await issue(db, doc.id, { posted_by }) : doc
    await db.run(
      `INSERT INTO billed_period(id, subscription_id, from_date, to_date, doc_id, seats, amount)
       VALUES (?,?,?,?,?,?,?)`,
      uid(), s.id, span.from_date, span.to_date, finished.id, s.seats, amount)
    await advance(db, s, span)
    made.push(finished)
  }
  return made
}

async function advance(db, s, span) {
  if (!span.next || s.interval === 'once') {
    await db.run("UPDATE subscription SET next_bill_on = NULL, status = 'ended' WHERE id = ?", s.id)
    return
  }
  const ending = (s.end_date && span.next > s.end_date) || s.cancel_at_end
  await db.run(
    `UPDATE subscription SET next_bill_on = ?, status = ? WHERE id = ?`,
    ending ? null : span.next, ending ? 'ended' : 'active', s.id)
}

/** Committed revenue per month at today's seat counts — what is standing. */
export async function recurringMonthly(db, entityId) {
  const rows = await db.all(
    `SELECT s.seats, COALESCE(s.price_override, p.price) AS unit, p.interval, p.currency
       FROM subscription s JOIN plan p ON p.id = s.plan_id
      WHERE s.entity_id = ? AND s.status = 'active'`, entityId)
  const perMonth = { }
  for (const r of rows) {
    const months = STEP[r.interval] ?? 1
    const ccy = r.currency || 'THB'
    perMonth[ccy] = (perMonth[ccy] || 0) + Math.round((r.unit * r.seats) / months)
  }
  return perMonth
}
