// entities.mjs — books get created here: the entity, its chart of accounts,
// its filing obligations, its projects, its people and their shares.
//
// A new entity arrives complete. Creating one writes the standard chart, the
// partner capital accounts for whoever holds shares, and the filing calendar
// its kind and registration imply — so the first thing anyone sees is a set of
// books that can already take a posting, not an empty table to fill in.

import { uid } from '../lib/ids.mjs'
import * as TH from '../lib/jurisdictions/th.mjs'
import { jurisdictionFor, codeFor } from '../lib/jurisdictions/index.mjs'

/**
 * The chart, the filing calendar and the starting rates all come from the
 * country's pack — Thailand's or Cambodia's — so creating a set of books in
 * either place writes what belongs there and nothing in this file knows a
 * country's name.
 */
export const STANDARD_CHART = TH.CHART
export const OBLIGATION_TEMPLATES = TH.OBLIGATIONS

export async function seedRatesInto(db, country = 'TH') {
  const jur = codeFor(country)
  const pack = jurisdictionFor(country)
  const rows = [
    ...pack.RATES,
    // The salary ladder is data too, one row per band, so it can be changed
    // from the app when a sub-decree moves it.
    ...pack.SALARY_BANDS.map((band, i) => ({
      scope: 'pit_band',
      code: String(i + 1),
      value_bp: band.bp,
      value_satang: band.upTo === Infinity ? null : band.upTo,
      from_date: '2000-01-01',
      source: band.source ?? null,
      unconfirmed: band.unconfirmed ?? false,
    })),
  ]
  for (const r of rows) {
    const seen = await db.get(
      'SELECT id FROM rate WHERE jur = ? AND scope = ? AND code = ? AND from_date = ?',
      jur, r.scope, r.code, r.from_date)
    if (seen) continue
    await db.run(
      `INSERT INTO rate(id, jur, scope, code, value_bp, value_satang, from_date, to_date,
         source, unconfirmed)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      uid(), jur, r.scope, r.code, r.value_bp ?? null, r.value_satang ?? null,
      r.from_date, r.to_date ?? null, r.source ?? null, r.unconfirmed ? 1 : 0)
  }
}

export async function createEntity(db, {
  code, name_en, name_th = null, name_km = null, kind = 'sole', currency = null,
  report_currency = null, country = 'TH', tax_id = null, vat_registered = 0, vat_from = null,
  address_en = null, address_th = null, address_km = null,
  locale = 'en', second_locale = null, fiscal_year_end = '12-31', note = null,
}) {
  const pack = jurisdictionFor(country)
  const id = uid()
  await db.run(
    `INSERT INTO entity(id, code, name_en, name_th, name_km, kind, country, currency,
       report_currency, tax_id, vat_registered, vat_from, address_en, address_th,
       address_km, locale, second_locale, fiscal_year_end, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, code, name_en, name_th, name_km, kind, country,
    currency || pack.CURRENCY,
    // What a return is filed in, which is not always what the books add up in.
    report_currency || pack.REPORT_CURRENCY || currency || pack.CURRENCY, tax_id, vat_registered ? 1 : 0, vat_from,
    address_en, address_th, address_km, locale, second_locale, fiscal_year_end, note)
  await seedChart(db, id, pack.CHART)
  await seedObligations(db, id, pack.OBLIGATIONS)
  await seedRatesInto(db, country)
  return db.get('SELECT * FROM entity WHERE id = ?', id)
}

export async function seedChart(db, entityId, chart = STANDARD_CHART) {
  const e = await db.get('SELECT country FROM entity WHERE id = ?', entityId)
  const local = String(e?.country).toUpperCase() === 'KH' ? 'name_km' : 'name_th'
  for (const [acode, name_en, name_local, type, subtype] of chart) {
    const seen = await accountExists(db, entityId, acode)
    if (seen) continue
    await db.run(
      `INSERT INTO account(id, entity_id, code, name_en, ${local}, type, subtype)
       VALUES (?,?,?,?,?,?,?)`,
      uid(), entityId, acode, name_en, name_local, type, subtype)
  }
}

const accountExists = (db, entityId, code) =>
  db.get('SELECT id FROM account WHERE entity_id = ? AND code = ?', entityId, code)

/**
 * Per-partner capital and drawings accounts, numbered under 3000/3100. Shares
 * are tracked in `holding`; these accounts are where each partner's money in
 * and money out actually sits, which is the other half of a partner statement.
 */
export async function ensurePartnerAccounts(db, entityId, person) {
  const n = (await db.all(
    "SELECT id FROM account WHERE entity_id = ? AND code LIKE '30%' AND person_id IS NOT NULL",
    entityId)).length + 1
  const cap = `30${String(n).padStart(2, '0')}`
  const draw = `31${String(n).padStart(2, '0')}`
  for (const [code, en, th, ] of [
    [cap, `Capital — ${person.name_en}`, `ทุน — ${person.name_th || person.name_en}`],
    [draw, `Drawings — ${person.name_en}`, `เงินถอน — ${person.name_th || person.name_en}`],
  ]) {
    if (await accountExists(db, entityId, code)) continue
    await db.run(
      `INSERT INTO account(id, entity_id, code, name_en, name_th, type, subtype, person_id)
       VALUES (?,?,?,?,?,'equity','equity_partner',?)`,
      uid(), entityId, code, en, th, person.id)
  }
  return { capital: cap, drawings: draw }
}

export async function seedObligations(db, entityId, templates = OBLIGATION_TEMPLATES) {
  const e = await db.get('SELECT * FROM entity WHERE id = ?', entityId)
  const from = e.vat_from || `${new Date().getUTCFullYear()}-01-01`
  for (const t of templates) {
    const seen = await db.get(
      'SELECT id FROM obligation WHERE entity_id = ? AND code = ?', entityId, t.code)
    if (seen) continue
    await db.run(
      `INSERT INTO obligation(id, entity_id, code, name_en, name_th, name_km, authority,
         frequency, due_rule, efile_bonus_days, applies_when, active_from, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), entityId, t.code, t.name_en, t.name_th ?? null, t.name_km ?? null,
      t.authority, t.frequency, t.due_rule, t.efile_bonus_days, t.applies_when,
      from, t.source ?? null)
  }
}

export async function addProject(db, entityId, {
  code, name_en, name_th = null, name_km = null, lane = null, url = null,
  status = 'live', cost_centre = 'company', note = null,
}) {
  const seen = await db.get('SELECT * FROM project WHERE code = ?', code)
  if (seen) return seen
  const id = uid()
  await db.run(
    `INSERT INTO project(id, entity_id, code, name_en, name_th, name_km, lane, url,
       status, cost_centre, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, entityId, code, name_en, name_th, name_km, lane, url, status, cost_centre, note)
  return db.get('SELECT * FROM project WHERE id = ?', id)
}

export async function addPerson(db, {
  code, name_en, name_th = null, name_km = null, locale = 'en', email = null,
  tax_id = null, sso_number = null, line_user_id = null,
}) {
  const seen = await db.get('SELECT * FROM person WHERE code = ?', code)
  if (seen) return seen
  const id = uid()
  await db.run(
    `INSERT INTO person(id, code, name_en, name_th, name_km, locale, email,
       tax_id, sso_number, line_user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, code, name_en, name_th, name_km, locale, email, tax_id, sso_number, line_user_id)
  return db.get('SELECT * FROM person WHERE id = ?', id)
}

const ROLE_CAPS = {
  owner: { can_post: 1, can_issue: 1, can_pay: 1, can_close: 1, can_see_pay: 1 },
  partner: { can_post: 0, can_issue: 0, can_pay: 0, can_close: 0, can_see_pay: 0 },
  director: { can_post: 1, can_issue: 1, can_pay: 1, can_close: 0, can_see_pay: 1 },
  bookkeeper: { can_post: 1, can_issue: 1, can_pay: 0, can_close: 0, can_see_pay: 1 },
  staff: { can_post: 0, can_issue: 1, can_pay: 0, can_close: 0, can_see_pay: 0 },
  viewer: { can_post: 0, can_issue: 0, can_pay: 0, can_close: 0, can_see_pay: 0 },
}

/** Role sets the usual capabilities; any of them can be overridden per person,
 *  because a partner who also keeps the books is a real arrangement. */
export async function addMembership(db, { person_id, entity_id, role = 'viewer', ...over }) {
  const caps = { ...ROLE_CAPS[role], ...over }
  const seen = await db.get(
    'SELECT * FROM membership WHERE person_id = ? AND entity_id = ?', person_id, entity_id)
  if (seen) {
    await db.run(
      `UPDATE membership SET role = ?, can_post = ?, can_issue = ?, can_pay = ?,
         can_close = ?, can_see_pay = ? WHERE id = ?`,
      role, caps.can_post, caps.can_issue, caps.can_pay, caps.can_close,
      caps.can_see_pay, seen.id)
    return db.get('SELECT * FROM membership WHERE id = ?', seen.id)
  }
  const id = uid()
  await db.run(
    `INSERT INTO membership(id, person_id, entity_id, role, can_post, can_issue,
       can_pay, can_close, can_see_pay) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, person_id, entity_id, role, caps.can_post, caps.can_issue, caps.can_pay,
    caps.can_close, caps.can_see_pay)
  return db.get('SELECT * FROM membership WHERE id = ?', id)
}

export function can(membership, capability) {
  if (!membership) return false
  return membership[`can_${capability}`] === 1
}

/**
 * Record a shareholding from a date. An earlier open holding for the same
 * person is closed the day before, so the history reads as a sequence rather
 * than overlapping claims on the same shares.
 */
export async function setHolding(db, { entity_id, person_id, share_bp, from_date, class: cls = 'ordinary', note = null }) {
  const open = await db.get(
    `SELECT * FROM holding WHERE entity_id = ? AND person_id = ? AND to_date IS NULL
      ORDER BY from_date DESC LIMIT 1`, entity_id, person_id)
  if (open) {
    const dayBefore = new Date(Date.parse(`${from_date}T00:00:00Z`) - 86400000)
      .toISOString().slice(0, 10)
    await db.run('UPDATE holding SET to_date = ? WHERE id = ?', dayBefore, open.id)
  }
  const id = uid()
  await db.run(
    `INSERT INTO holding(id, entity_id, person_id, share_bp, class, from_date, note)
     VALUES (?,?,?,?,?,?,?)`, id, entity_id, person_id, share_bp, cls, from_date, note)
  return db.get('SELECT * FROM holding WHERE id = ?', id)
}

/** Holdings in force on a date, with the people attached. */
export async function holdingsOn(db, entityId, onDate) {
  return db.all(
    `SELECT h.*, p.code AS person_code, p.name_en, p.name_th
       FROM holding h JOIN person p ON p.id = h.person_id
      WHERE h.entity_id = ? AND h.from_date <= ?
        AND (h.to_date IS NULL OR h.to_date >= ?)
      ORDER BY h.share_bp DESC`, entityId, onDate, onDate)
}
