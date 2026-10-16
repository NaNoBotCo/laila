// calendar.mjs — the books, laid out as days.
//
// Everything in a set of books that carries a date belongs on one grid: what
// has to be filed, what is due to be paid, what will bill itself, when people
// are paid, when a referral was sent on. A month view is the cheapest way to
// see time-bound structured data, and it answers the question a list cannot —
// what does this WEEK look like.
//
// Two quieter layers sit underneath: the days nobody is working, and the shape
// of the day itself. The second is a footnote by design.

import { uid } from '../lib/ids.mjs'
import { sunTimes, prayerTimes, placeFor } from '../lib/sun.mjs'
import { observancesIn } from '../lib/hijri.mjs'
import { jurisdictionFor } from '../lib/jurisdictions/index.mjs'

const pad = (n) => String(n).padStart(2, '0')
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`

/** Kept for callers that ask for a country by name; the lists themselves live
 *  in the jurisdiction packs, beside that country's rates and filings. */
export const FIXED_TH_HOLIDAYS = jurisdictionFor('TH').HOLIDAYS
export const FIXED_KH_HOLIDAYS = jurisdictionFor('KH').HOLIDAYS

/** Write the fixed holidays for a year, plus the observances that are
 *  calculated and marked as such. Existing rows are left alone. */
export async function seedYear(db, year, { entity_id = null, country = null } = {}) {
  const made = []
  // Which country's days off. A deadline that lands on one moves, and the days
  // are not the same in Bangkok and Phnom Penh.
  const place = String(
    country ?? (entity_id
      ? (await db.get('SELECT country FROM entity WHERE id = ?', entity_id))?.country
      : 'TH') ?? 'TH').toUpperCase()
  // The list comes from the pack, so a third country is a pack and not an edit
  // here.
  const fixed = jurisdictionFor(place).HOLIDAYS
  for (const [md, name_en, local] of fixed) {
    made.push(await addHoliday(db, {
      entity_id,
      on_date: `${year}-${md}`,
      name_en,
      ...(place === 'KH' ? { name_km: local } : { name_th: local }),
      kind: 'public',
      moves_deadline: 1,
      source: 'fixed date',
    }))
  }
  for (const o of observancesIn(year)) {
    made.push(await addHoliday(db, {
      entity_id, on_date: o.on, name_en: o.name_en, name_th: o.name_th,
      kind: 'observance', moves_deadline: 0, expected: 1,
      source: `calculated · ${o.hijri}`,
    }))
  }
  return made.filter(Boolean)
}

export async function addHoliday(db, {
  entity_id = null, on_date, name_en, name_th = null, name_km = null, kind = 'public',
  moves_deadline = 1, expected = 0, source = null, note = null,
}) {
  const seen = await db.get(
    `SELECT * FROM holiday WHERE on_date = ? AND name_en = ?
       AND (entity_id IS ? OR entity_id = ?)`,
    on_date, name_en, entity_id, entity_id)
  if (seen) return null
  const id = uid()
  await db.run(
    `INSERT INTO holiday(id, entity_id, on_date, name_en, name_th, name_km, kind,
       moves_deadline, expected, source, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, on_date, name_en, name_th, name_km, kind, moves_deadline ? 1 : 0,
    expected ? 1 : 0, source, note)
  return db.get('SELECT * FROM holiday WHERE id = ?', id)
}

export const holidaysBetween = (db, { from, to, entity_id = null }) => db.all(
  `SELECT * FROM holiday
    WHERE is_active = 1 AND on_date BETWEEN ? AND ?
      AND (entity_id IS NULL OR entity_id = ?)
    ORDER BY on_date`, from, to, entity_id)

/** Days a filing deadline slides past: weekends, and the holidays marked. */
export async function nonWorkingDays(db, { from, to, entity_id = null }) {
  const rows = await db.all(
    `SELECT on_date FROM holiday
      WHERE is_active = 1 AND moves_deadline = 1 AND on_date BETWEEN ? AND ?
        AND (entity_id IS NULL OR entity_id = ?)`, from, to, entity_id)
  return new Set(rows.map((r) => r.on_date))
}

// ---- the month --------------------------------------------------------------

const addDays = (dateStr, n) =>
  new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

/**
 * One month of days, each carrying whatever the books put on it.
 *
 * Items are {kind, label, amount, id} so the screen can render them without
 * knowing where each came from, and the caller can filter by kind.
 */
export async function month(db, entityId, ym, { place = null } = {}) {
  const [y, m] = ym.split('-').map(Number)
  const from = iso(y, m, 1)
  const to = iso(y, m, lastDayOf(y, m))
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entityId)
  const where = { entity_id: entityId }

  const days = new Map()
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date, items: [], holidays: [] })
    return days.get(date)
  }
  for (let d = 1; d <= lastDayOf(y, m); d++) day(iso(y, m, d))

  const add = (date, item) => {
    if (date < from || date > to) return
    day(date).items.push(item)
  }

  for (const h of await holidaysBetween(db, { from, to, entity_id: entityId })) {
    day(h.on_date).holidays.push(h)
  }

  const filings = await db.all(
    `SELECT f.*, o.code, o.name_en, o.name_th, o.name_km FROM filing f
       JOIN obligation o ON o.id = f.obligation_id
      WHERE f.entity_id = ? AND (f.due_date BETWEEN ? AND ? OR f.efile_date BETWEEN ? AND ?)`,
    entityId, from, to, from, to)
  for (const f of filings) {
    if (f.due_date >= from && f.due_date <= to) {
      add(f.due_date, {
        kind: 'filing', id: f.id, code: f.code,
        label_en: `${f.code} ${f.period}`, label_th: `${f.code} ${f.period}`,
        amount: f.amount, status: f.status,
      })
    }
    if (f.efile_date && f.efile_date >= from && f.efile_date <= to) {
      add(f.efile_date, {
        kind: 'filing_online', id: f.id, code: f.code,
        label_en: `${f.code} ${f.period} online`, label_th: `${f.code} ${f.period} ออนไลน์`,
        amount: f.amount, status: f.status,
      })
    }
  }

  const docs = await db.all(
    `SELECT d.*, y.name_en AS party_name_en, y.name_th AS party_name_th,
            y.name_km AS party_name_km
       FROM doc d JOIN party y ON y.id = d.party_id
      WHERE d.entity_id = ? AND d.status IN ('issued','part_paid')
        AND COALESCE(d.due_date, d.issue_date) BETWEEN ? AND ?`,
    entityId, from, to)
  for (const d of docs) {
    add(d.due_date || d.issue_date, {
      kind: d.direction === 'out' ? 'receivable' : 'payable',
      id: d.id,
      label_en: `${d.number} · ${d.party_name_en}`,
      label_th: `${d.number} · ${d.party_name_th || d.party_name_en}`,
      amount: d.gross - d.paid - d.wht_credited,
    })
  }

  const subs = await db.all(
    `SELECT s.*, pl.name_en AS plan_en, pl.name_th AS plan_th,
            pl.name_km AS plan_km,
            y.name_en AS party_name_en, y.name_th AS party_name_th,
            y.name_km AS party_name_km
       FROM subscription s JOIN plan pl ON pl.id = s.plan_id JOIN party y ON y.id = s.party_id
      WHERE s.entity_id = ? AND s.status = 'active' AND s.next_bill_on BETWEEN ? AND ?`,
    entityId, from, to)
  for (const s of subs) {
    add(s.next_bill_on, {
      kind: 'billing', id: s.id,
      label_en: `${s.party_name_en} · ${s.plan_en}`,
      label_th: `${s.party_name_th || s.party_name_en} · ${s.plan_th || s.plan_en}`,
      amount: (s.price_override ?? 0) || null,
    })
  }

  const runs = await db.all(
    'SELECT * FROM pay_run WHERE entity_id = ? AND pay_date BETWEEN ? AND ?',
    entityId, from, to)
  for (const r of runs) {
    add(r.pay_date, {
      kind: 'payroll', id: r.id,
      label_en: `Payroll ${r.ym}`, label_th: `เงินเดือน ${r.ym}`,
      status: r.status,
    })
  }

  const referrals = await db.all(
    `SELECT * FROM referral WHERE entity_id = ?
      AND (sent_on BETWEEN ? AND ? OR completed_on BETWEEN ? AND ?)`,
    entityId, from, to, from, to)
  for (const r of referrals) {
    if (r.completed_on >= from && r.completed_on <= to) {
      add(r.completed_on, {
        kind: 'referral_done', id: r.id,
        label_en: `${r.label || r.external_id} · earned`,
        label_th: `${r.label || r.external_id} · ได้ส่วนแบ่ง`,
        amount: r.commission,
      })
    } else if (r.sent_on >= from && r.sent_on <= to) {
      add(r.sent_on, {
        kind: 'referral_sent', id: r.id,
        label_en: `${r.label || r.external_id} · sent on`,
        label_th: `${r.label || r.external_id} · ส่งต่อ`,
      })
    }
  }

  const where_ = place || entity?.place || 'Chiang Rai'
  const spot = entity?.lat != null && entity?.lng != null
    ? { lat: entity.lat, lng: entity.lng, tzOffsetMinutes: 420 }
    : placeFor(where_)

  return {
    ym,
    from,
    to,
    place: where_,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({
      ...d,
      weekday: new Date(`${d.date}T00:00:00Z`).getUTCDay(),
      sun: sunTimes(d.date, spot),
    })),
  }
}

/** One day, with the quiet detail the month view leaves out. */
export async function dayDetail(db, entityId, date, { place = null, prayer = {} } = {}) {
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entityId)
  const spot = entity?.lat != null && entity?.lng != null
    ? { lat: entity.lat, lng: entity.lng, tzOffsetMinutes: 420 }
    : placeFor(place || entity?.place || 'Chiang Rai')
  const grid = await month(db, entityId, date.slice(0, 7), { place })
  const found = grid.days.find((d) => d.date === date)
  return {
    ...found,
    sun: sunTimes(date, spot),
    prayer: prayerTimes(date, spot, prayer),
  }
}

/** The next day that is neither a weekend nor a holiday that moves deadlines. */
export async function nextWorkingDay(db, dateStr, { entity_id = null } = {}) {
  const closed = await nonWorkingDays(db, {
    from: dateStr, to: addDays(dateStr, 14), entity_id,
  })
  let out = dateStr
  for (let i = 0; i < 14; i++) {
    const dow = new Date(`${out}T00:00:00Z`).getUTCDay()
    if (dow !== 0 && dow !== 6 && !closed.has(out)) return out
    out = addDays(out, 1)
  }
  return out
}
