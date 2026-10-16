// policy.mjs — the numbers and rules that change by decree rather than by
// decision: tax rates, the income tax schedule, filing deadlines, what a person
// is paid, the company's own registration details.
//
// TWO PROPERTIES, both deliberate:
//
//   1. NOTHING IS OVERWRITTEN. A change closes the old row the day before the
//      new one starts and inserts a new one. March's payslip keeps computing
//      March's answer after the rate moves in July, and a filing made under the
//      old rule can still be explained.
//   2. EVERY CHANGE IS RECORDED. Who, when, from what to what, from which date,
//      and the reason given — in `audit`, which nothing in this system deletes.
//
// So a rate change is a piece of paper, not a software release.

import { uid } from '../lib/ids.mjs'

const dayBefore = (date) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)

async function record(db, { entity_id = null, person_id = null, action, object_kind, object_id, detail }) {
  await db.run(
    `INSERT INTO audit(id, entity_id, person_id, action, object_kind, object_id, detail)
     VALUES (?,?,?,?,?,?,?)`,
    uid(), entity_id, person_id, action, object_kind, object_id,
    typeof detail === 'string' ? detail : JSON.stringify(detail))
}

// ---- tax rates --------------------------------------------------------------

/** Every rate in force on a date, under one country's law. */
export async function ratesOn(db, onDate, { scope = null, jur = 'TH' } = {}) {
  return db.all(
    `SELECT * FROM rate
      WHERE jur = ? AND from_date <= ? AND (to_date IS NULL OR to_date >= ?)
        AND (? IS NULL OR scope = ?)
      ORDER BY scope, CASE WHEN scope = 'pit_band' THEN CAST(code AS INTEGER) END, code`,
    jur, onDate, onDate, scope, scope)
}

/**
 * The rates in force that nobody has confirmed.
 *
 * A pack for a country whose figures were never checked — Laos, Myanmar — ships
 * its rates marked, so the app can say so on the screen where they are used
 * instead of presenting a placeholder as law. Setting the rate clears the mark.
 */
export async function unconfirmedRates(db, onDate, { jur = 'TH' } = {}) {
  return db.all(
    `SELECT * FROM rate
      WHERE jur = ? AND unconfirmed = 1 AND from_date <= ?
        AND (to_date IS NULL OR to_date >= ?)
      ORDER BY scope, code`, jur, onDate, onDate)
}

/** Every version of one rate, newest first — the history of a number. */
export async function rateHistory(db, scope, code, jur = 'TH') {
  return db.all(
    'SELECT * FROM rate WHERE jur = ? AND scope = ? AND code = ? ORDER BY from_date DESC',
    jur, scope, code)
}

/**
 * Change a rate from a date.
 *
 * The version in force before that date keeps its rows and gets an end date; a
 * change starting today does not reach back into a return already filed.
 */
export async function setRate(db, {
  scope, code, value_bp = null, value_satang = null, from_date, source = null,
  person_id = null, note = null, jur = 'TH', unconfirmed = false,
}) {
  if (!scope || !code) throw new Error('A rate needs a scope and a code.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from_date || ''))) {
    throw new Error(`Not a date: ${from_date}`)
  }
  const current = await db.get(
    `SELECT * FROM rate WHERE jur = ? AND scope = ? AND code = ? AND from_date <= ?
       AND (to_date IS NULL OR to_date >= ?) ORDER BY from_date DESC LIMIT 1`,
    jur, scope, code, from_date, from_date)

  if (current && current.from_date === from_date) {
    // Same start date: this is a correction of a row nothing has relied on yet.
    // Somebody typed it, so it stops being a figure nobody has checked.
    await db.run(
      'UPDATE rate SET value_bp = ?, value_satang = ?, source = ?, unconfirmed = ? WHERE id = ?',
      value_bp, value_satang, source ?? current.source, unconfirmed ? 1 : 0, current.id)
  } else {
    if (current) {
      await db.run('UPDATE rate SET to_date = ? WHERE id = ?', dayBefore(from_date), current.id)
    }
    await db.run(
      `INSERT INTO rate(id, jur, scope, code, value_bp, value_satang, from_date, to_date,
         source, unconfirmed)
       VALUES (?,?,?,?,?,?,?,NULL,?,?)`,
      uid(), jur, scope, code, value_bp, value_satang, from_date, source, unconfirmed ? 1 : 0)
  }

  await record(db, {
    person_id,
    action: 'rate.set',
    object_kind: 'rate',
    object_id: `${jur}:${scope}:${code}`,
    detail: {
      jur,
      from_date,
      was: current ? { value_bp: current.value_bp, value_satang: current.value_satang } : null,
      now: { value_bp, value_satang },
      source,
      note,
    },
  })
  return db.get(
    'SELECT * FROM rate WHERE jur = ? AND scope = ? AND code = ? AND from_date = ?',
    jur, scope, code, from_date)
}

/** Replace the income tax schedule from a date — the whole ladder at once,
 *  because a band only means anything beside the ones around it. */
export async function setBands(db, {
  bands, from_date, source = null, person_id = null, jur = 'TH',
}) {
  const old = await ratesOn(db, from_date, { scope: 'pit_band', jur })
  for (const row of old) {
    if (row.from_date === from_date) await db.run('DELETE FROM rate WHERE id = ?', row.id)
    else await db.run('UPDATE rate SET to_date = ? WHERE id = ?', dayBefore(from_date), row.id)
  }
  let n = 0
  for (const band of bands) {
    n++
    await db.run(
      `INSERT INTO rate(id, jur, scope, code, value_bp, value_satang, from_date, source)
       VALUES (?,?,'pit_band',?,?,?,?,?)`,
      uid(), jur, String(n), band.bp, band.upTo === Infinity ? null : band.upTo,
      from_date, source)
  }
  await record(db, {
    person_id,
    action: 'rate.bands',
    object_kind: 'rate',
    object_id: `${jur}:pit_band`,
    detail: { jur, from_date, was: old.map((r) => ({ upTo: r.value_satang, bp: r.value_bp })), now: bands, source },
  })
  return ratesOn(db, from_date, { scope: 'pit_band', jur })
}

// ---- filing rules -----------------------------------------------------------

/**
 * Change a filing rule — the due-date arithmetic, the days electronic filing
 * adds, or whether it applies at all. The old rule is closed rather than
 * edited, so filings already generated keep the dates they were given.
 */
export async function setObligation(db, {
  entity_id, code, name_en = null, name_th = null, authority = null, frequency = null,
  due_rule = null, efile_bonus_days = null, applies_when = null, active_from,
  source = null, person_id = null, active = true,
}) {
  const current = await db.get(
    `SELECT * FROM obligation WHERE entity_id = ? AND code = ?
       AND (active_to IS NULL OR active_to >= ?) ORDER BY active_from DESC LIMIT 1`,
    entity_id, code, active_from)
  if (current) {
    await db.run('UPDATE obligation SET active_to = ? WHERE id = ?',
      dayBefore(active_from), current.id)
  }
  if (active) {
    await db.run(
      `INSERT INTO obligation(id, entity_id, code, name_en, name_th, authority,
         frequency, due_rule, efile_bonus_days, applies_when, active_from, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), entity_id, code,
      name_en ?? current?.name_en ?? code,
      name_th ?? current?.name_th ?? null,
      authority ?? current?.authority ?? 'revenue',
      frequency ?? current?.frequency ?? 'monthly',
      due_rule ?? current?.due_rule ?? 'day:15',
      efile_bonus_days ?? current?.efile_bonus_days ?? 0,
      applies_when ?? current?.applies_when ?? 'always',
      active_from, source)
  }
  await record(db, {
    entity_id,
    person_id,
    action: active ? 'obligation.set' : 'obligation.stop',
    object_kind: 'obligation',
    object_id: code,
    detail: {
      active_from,
      was: current
        ? { due_rule: current.due_rule, efile_bonus_days: current.efile_bonus_days,
          applies_when: current.applies_when, frequency: current.frequency }
        : null,
      now: active ? { due_rule, efile_bonus_days, applies_when, frequency } : null,
      source,
    },
  })
  return db.all(
    'SELECT * FROM obligation WHERE entity_id = ? AND code = ? ORDER BY active_from DESC',
    entity_id, code)
}

// ---- what a person is paid --------------------------------------------------

/**
 * A pay change is a new employment row from the date it takes effect, and the
 * old one ends the day before. Payslips already run keep pointing at the row
 * they were computed from, which is what makes a back-dated question answerable.
 */
export async function changePay(db, employmentId, {
  pay_rate = null, pay_unit = null, from_date, sso_registered = null,
  tax_withheld = null, title_en = null, title_th = null, person_id = null, note = null,
}) {
  const current = await db.get('SELECT * FROM employment WHERE id = ?', employmentId)
  if (!current) throw new Error('No such employment.')
  await db.run('UPDATE employment SET end_date = ? WHERE id = ?',
    dayBefore(from_date), employmentId)
  const id = uid()
  await db.run(
    `INSERT INTO employment(id, entity_id, person_id, title_en, title_th, pay_unit,
       pay_rate, currency, hours_per_day, start_date, sso_registered, sso_from,
       tax_withheld, allowances, cost_centre, contract_ref, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, current.entity_id, current.person_id,
    title_en ?? current.title_en, title_th ?? current.title_th,
    pay_unit ?? current.pay_unit, pay_rate ?? current.pay_rate, current.currency,
    current.hours_per_day, from_date,
    sso_registered == null ? current.sso_registered : (sso_registered ? 1 : 0),
    current.sso_from,
    tax_withheld == null ? current.tax_withheld : (tax_withheld ? 1 : 0),
    current.allowances, current.cost_centre, current.contract_ref, note ?? current.note)
  await record(db, {
    entity_id: current.entity_id,
    person_id,
    action: 'pay.change',
    object_kind: 'employment',
    object_id: current.person_id,
    detail: {
      from_date,
      was: { pay_rate: current.pay_rate, pay_unit: current.pay_unit,
        sso_registered: current.sso_registered, tax_withheld: current.tax_withheld },
      now: { pay_rate: pay_rate ?? current.pay_rate, pay_unit: pay_unit ?? current.pay_unit,
        sso_registered, tax_withheld },
      note,
    },
  })
  return db.get('SELECT * FROM employment WHERE id = ?', id)
}

// ---- the company's own details ---------------------------------------------

const ENTITY_FIELDS = new Set([
  'name_en', 'name_th', 'tax_id', 'vat_registered', 'vat_from', 'address_en',
  'address_th', 'fiscal_year_end', 'currency', 'kind', 'status',
])

/** Registration details change too — a VAT number arrives, an address moves. */
export async function setEntityDetails(db, entityId, changes, { person_id = null, note = null } = {}) {
  const before = await db.get('SELECT * FROM entity WHERE id = ?', entityId)
  const fields = Object.entries(changes).filter(([k]) => ENTITY_FIELDS.has(k))
  if (!fields.length) return before
  await db.run(
    `UPDATE entity SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...fields.map(([, v]) => v), entityId)
  await record(db, {
    entity_id: entityId,
    person_id,
    action: 'entity.set',
    object_kind: 'entity',
    object_id: entityId,
    detail: {
      was: Object.fromEntries(fields.map(([k]) => [k, before[k]])),
      now: Object.fromEntries(fields),
      note,
    },
  })
  return db.get('SELECT * FROM entity WHERE id = ?', entityId)
}

// ---- a price, a plan, a term ------------------------------------------------

/** A plan's price, with the old one recorded. Subscriptions already running
 *  keep their own price until they are changed. */
export async function setPlanPrice(db, planId, { price, person_id = null, note = null }) {
  const before = await db.get('SELECT * FROM plan WHERE id = ?', planId)
  await db.run('UPDATE plan SET price = ? WHERE id = ?', price, planId)
  await record(db, {
    entity_id: before.entity_id,
    person_id,
    action: 'plan.price',
    object_kind: 'plan',
    object_id: before.code,
    detail: { was: before.price, now: price, note },
  })
  return db.get('SELECT * FROM plan WHERE id = ?', planId)
}

// ---- reading the record -----------------------------------------------------

/** What has been changed, newest first. The record is append-only. */
export async function changeLog(db, { entity_id = null, object_kind = null, limit = 100 } = {}) {
  const rows = await db.all(
    `SELECT a.*, p.name_en AS person_name_en, p.name_th AS person_name_th,
            p.name_km AS person_name_km
       FROM audit a LEFT JOIN person p ON p.id = a.person_id
      WHERE (? IS NULL OR a.entity_id = ? OR a.entity_id IS NULL)
        AND (? IS NULL OR a.object_kind = ?)
        AND a.action <> 'note'
      ORDER BY a.at DESC LIMIT ?`,
    entity_id, entity_id, object_kind, object_kind, limit)
  return rows.map((r) => ({ ...r, detail: safeParse(r.detail) }))
}

const safeParse = (s) => {
  try { return JSON.parse(s) } catch { return s }
}
