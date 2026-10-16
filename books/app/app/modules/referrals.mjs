// referrals.mjs — cases sent to somebody else, and the share that comes back.
//
// The shape of the problem: work leaves here, the other desk does it, and a
// month later there is a number to agree. Two things go wrong in that month —
// the referral is forgotten, or the two sides count differently. So this module
// keeps a row per case with its own status, computes the commission ONCE at
// completion and freezes the terms onto the row, bills a whole month as one
// invoice, and can be read against the other side's statement line by line.
//
// Nothing here posts to the ledger until a commission is billed: a case that
// has been sent is not income, and treating it as income is how a pipeline
// starts lying.

import { uid } from '../lib/ids.mjs'
import { draft, issue } from './documents.mjs'
import { accountByCode } from './books.mjs'

const dayBefore = (date) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)

const addDays = (date, n) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

async function record(db, { entity_id, person_id = null, action, object_id, detail }) {
  await db.run(
    `INSERT INTO audit(id, entity_id, person_id, action, object_kind, object_id, detail)
     VALUES (?,?,?,?,'referral',?,?)`,
    uid(), entity_id, person_id, action, object_id, JSON.stringify(detail))
}

// ---- the agreement ----------------------------------------------------------

/** The terms in force on a date, for one code. */
export const agreementOn = (db, entityId, code, onDate) => db.get(
  `SELECT * FROM referral_agreement
    WHERE entity_id = ? AND code = ? AND from_date <= ?
      AND (to_date IS NULL OR to_date >= ?)
    ORDER BY from_date DESC LIMIT 1`, entityId, code, onDate, onDate)

export const agreements = (db, entityId) => db.all(
  `SELECT a.*, y.name_en AS party_name_en, y.name_th AS party_name_th,
            y.name_km AS party_name_km
     FROM referral_agreement a JOIN party y ON y.id = a.party_id
    WHERE a.entity_id = ? ORDER BY a.code, a.from_date DESC`, entityId)

/**
 * Write terms from a date. An earlier version is closed the day before rather
 * than edited, because cases already completed were earned under it.
 */
export async function setAgreement(db, {
  entity_id, party_id, code, name_en, name_th = null, name_km = null, basis = 'percent_of_fee',
  rate_bp = null, fixed_amount = null, tiers = null, currency = null,
  wht_bp = 300, project_id = null, account_code = '4900', terms_days = 15,
  from_date, source = null, note = null, person_id = null,
}) {
  const current = await agreementOn(db, entity_id, code, from_date)
  if (current && current.from_date === from_date) {
    await db.run('DELETE FROM referral_agreement WHERE id = ?', current.id)
  } else if (current) {
    await db.run('UPDATE referral_agreement SET to_date = ? WHERE id = ?',
      dayBefore(from_date), current.id)
  }
  const books = await db.get('SELECT currency FROM entity WHERE id = ?', entity_id)
  const id = uid()
  await db.run(
    `INSERT INTO referral_agreement(id, entity_id, party_id, code, name_en, name_th,
       name_km, basis, rate_bp, fixed_amount, tiers, currency, wht_bp, project_id,
       account_code, terms_days, from_date, source, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, party_id, code, name_en, name_th, name_km, basis, rate_bp, fixed_amount,
    tiers ? JSON.stringify(tiers) : null, currency || books?.currency || 'THB',
    wht_bp, project_id,
    account_code, terms_days, from_date, source, note)
  await record(db, {
    entity_id, person_id, action: 'referral.terms', object_id: code,
    detail: {
      from_date,
      was: current ? { basis: current.basis, rate_bp: current.rate_bp, fixed_amount: current.fixed_amount } : null,
      now: { basis, rate_bp, fixed_amount },
      source,
    },
  })
  return db.get('SELECT * FROM referral_agreement WHERE id = ?', id)
}

/**
 * What one completed case earns under a set of terms.
 *
 * Returns the amount and the working, so the invoice line can say how it was
 * arrived at and a disagreement is about a number rather than about a method.
 */
export function commissionFor(agreement, { case_fee = 0, caseIndex = 0, net_cost = null } = {}) {
  if (!agreement) return { amount: 0, basis: null, rate_bp: null, why: 'no agreement' }
  // The margin arrangement: they do it at a net price, the client is quoted a
  // retail price, and the difference is what the referral earned. No rate is
  // involved, so none is reported.
  if (agreement.basis === 'margin') {
    // Without the other desk's price there is no margin to work out, and
    // treating an unknown net as zero made the WHOLE quoted fee look like the
    // earning — ฿25,000 where ฿9,000 was true. So it earns nothing until the
    // service is picked off the rate card and says what they charge.
    if (net_cost == null) {
      return {
        amount: 0,
        basis: 'margin',
        rate_bp: null,
        net: null,
        why: 'no net price recorded for this service',
      }
    }
    return {
      amount: Math.max(0, case_fee - net_cost),
      basis: 'margin',
      rate_bp: null,
      net: net_cost,
      why: 'the quoted price less what the other desk charges',
    }
  }
  if (agreement.basis === 'fixed_per_case') {
    return {
      amount: agreement.fixed_amount ?? 0,
      basis: 'fixed_per_case',
      rate_bp: null,
      why: 'fixed per completed case',
    }
  }
  if (agreement.basis === 'tiered') {
    const tiers = JSON.parse(agreement.tiers || '[]')
      .slice()
      .sort((a, b) => a.from_cases - b.from_cases)
    const tier = tiers.filter((t) => caseIndex + 1 >= t.from_cases).pop() || tiers[0]
    const bp = tier?.rate_bp ?? 0
    return {
      amount: Math.round((Math.abs(case_fee) * bp) / 10000) * Math.sign(case_fee || 1),
      basis: 'tiered',
      rate_bp: bp,
      why: `case ${caseIndex + 1} of the month`,
    }
  }
  const bp = agreement.rate_bp ?? 0
  return {
    amount: Math.round((Math.abs(case_fee) * bp) / 10000) * Math.sign(case_fee || 1),
    basis: 'percent_of_fee',
    rate_bp: bp,
    why: 'share of the fee charged',
  }
}

// ---- the rate card ----------------------------------------------------------

/** What a service costs and what it is quoted at, on a date. */
export const serviceRateOn = (db, agreementId, code, onDate) => db.get(
  `SELECT * FROM service_rate
    WHERE agreement_id = ? AND code = ? AND from_date <= ?
      AND (to_date IS NULL OR to_date >= ?)
    ORDER BY from_date DESC LIMIT 1`, agreementId, code, onDate, onDate)

export const rateCard = (db, agreementId, onDate) => db.all(
  `SELECT * FROM service_rate
    WHERE agreement_id = ? AND from_date <= ? AND (to_date IS NULL OR to_date >= ?)
    ORDER BY name_en`, agreementId, onDate, onDate)

async function netPriceFor(db, { agreement_id, code, onDate }) {
  if (!agreement_id || !code) return null
  const row = await serviceRateOn(db, agreement_id, code, onDate)
  return row?.net_price ?? null
}

/** Write a service's two prices from a date, closing the version before it. */
export async function setServiceRate(db, {
  agreement_id, code, name_en, name_th = null, net_price, retail_price = null,
  currency = 'THB', from_date, source = null, note = null, person_id = null,
}) {
  const current = await serviceRateOn(db, agreement_id, code, from_date)
  if (current && current.from_date === from_date) {
    await db.run('DELETE FROM service_rate WHERE id = ?', current.id)
  } else if (current) {
    await db.run('UPDATE service_rate SET to_date = ? WHERE id = ?',
      dayBefore(from_date), current.id)
  }
  const id = uid()
  await db.run(
    `INSERT INTO service_rate(id, agreement_id, code, name_en, name_th, net_price,
       retail_price, currency, from_date, source, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, agreement_id, code, name_en, name_th, net_price, retail_price, currency,
    from_date, source, note)
  const agreement = await db.get('SELECT * FROM referral_agreement WHERE id = ?', agreement_id)
  await record(db, {
    entity_id: agreement.entity_id,
    person_id,
    action: 'referral.rate_card',
    object_id: `${agreement.code}:${code}`,
    detail: {
      from_date,
      was: current ? { net: current.net_price, retail: current.retail_price } : null,
      now: { net: net_price, retail: retail_price },
      source,
    },
  })
  return db.get('SELECT * FROM service_rate WHERE id = ?', id)
}

// ---- the cases --------------------------------------------------------------

export async function addReferral(db, {
  entity_id, code, sent_on, label = null, service = null, channel = 'site',
  external_id = null, case_fee = null, net_cost = null, service_code = null,
  client_party_id = null, currency = null, note = null, idem_key = null,
  status = 'sent', agreement_id = null,
}) {
  const key = idem_key || (external_id ? `ref:${entity_id}:${external_id}` : null)
  if (key) {
    const seen = await db.get('SELECT * FROM referral WHERE idem_key = ?', key)
    if (seen) return seen
  }
  const agreement = agreement_id
    ? await db.get('SELECT * FROM referral_agreement WHERE id = ?', agreement_id)
    : await agreementOn(db, entity_id, code, sent_on)

  // A service from the rate card brings both prices with it, so a case is one
  // choice rather than two numbers typed from memory.
  const card = service_code && agreement
    ? await serviceRateOn(db, agreement.id, service_code, sent_on)
    : null

  const id = uid()
  await db.run(
    `INSERT INTO referral(id, entity_id, agreement_id, external_id, code, sent_on,
       label, service, channel, status, case_fee, net_cost, service_code,
       client_party_id, currency, note, idem_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, agreement?.id ?? null, external_id, code, sent_on,
    label ?? card?.name_en ?? null, service, channel, status,
    case_fee ?? card?.retail_price ?? null,
    net_cost ?? card?.net_price ?? null,
    service_code, client_party_id,
    currency || card?.currency || agreement?.currency ||
      (await db.get('SELECT currency FROM entity WHERE id = ?', entity_id))?.currency || 'THB',
    note, key)
  return db.get('SELECT * FROM referral WHERE id = ?', id)
}

/**
 * Move a case along. Completing it is the moment the commission is computed:
 * the terms in force that day are written onto the row and stop moving.
 */
export async function setStatus(db, referralId, {
  status, on_date, case_fee = null, net_cost = null, why = null, person_id = null,
}) {
  const r = await db.get('SELECT * FROM referral WHERE id = ?', referralId)
  if (!r) throw new Error('No such referral.')
  if (['billed', 'paid'].includes(r.status) && status !== 'void') {
    throw new Error(`${r.external_id || r.label} is already ${r.status}.`)
  }

  const fields = { status }
  if (status === 'accepted') fields.accepted_on = on_date
  if (status === 'declined') fields.declined_why = why
  if (status === 'completed') {
    fields.completed_on = on_date
    const fee = case_fee ?? r.case_fee ?? 0
    const agreement = r.agreement_id
      ? await db.get('SELECT * FROM referral_agreement WHERE id = ?', r.agreement_id)
      : await agreementOn(db, r.entity_id, r.code, on_date)
    // How many of this month's cases came before it — tiered terms need to know.
    const before = await db.get(
      `SELECT COUNT(*) AS n FROM referral
        WHERE entity_id = ? AND agreement_id = ? AND status IN ('completed','billed','paid')
          AND substr(completed_on,1,7) = ?`,
      r.entity_id, agreement?.id ?? null, String(on_date).slice(0, 7))
    const cost = net_cost ?? r.net_cost ?? await netPriceFor(db, {
      agreement_id: agreement?.id, code: r.service_code, onDate: on_date,
    })
    const worked = commissionFor(agreement, {
      case_fee: fee, caseIndex: before?.n ?? 0, net_cost: cost,
    })
    fields.case_fee = fee
    fields.net_cost = cost
    fields.commission = worked.amount
    fields.basis_used = worked.basis
    fields.rate_used_bp = worked.rate_bp
    if (agreement && !r.agreement_id) fields.agreement_id = agreement.id
  }

  const keys = Object.keys(fields)
  await db.run(
    `UPDATE referral SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...keys.map((k) => fields[k]), referralId)
  await record(db, {
    entity_id: r.entity_id, person_id, action: `referral.${status}`,
    object_id: r.external_id || referralId,
    detail: { was: r.status, now: status, on_date, case_fee: fields.case_fee ?? null, why },
  })
  return db.get('SELECT * FROM referral WHERE id = ?', referralId)
}

export const pipeline = (db, entityId, { status = null, limit = 200 } = {}) => db.all(
  `SELECT r.*, a.name_en AS agreement_name, a.party_id, y.name_en AS party_name_en,
          y.name_th AS party_name_th,
            y.name_km AS party_name_km
     FROM referral r
     LEFT JOIN referral_agreement a ON a.id = r.agreement_id
     LEFT JOIN party y ON y.id = a.party_id
    WHERE r.entity_id = ? AND (? IS NULL OR r.status = ?)
    ORDER BY r.sent_on DESC LIMIT ?`, entityId, status, status, limit)

/** What each state is worth — the pipeline as money rather than as a count. */
export async function pipelineTotals(db, entityId) {
  const rows = await db.all(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(commission),0) AS commission,
            COALESCE(SUM(case_fee),0) AS fees
       FROM referral WHERE entity_id = ? GROUP BY status`, entityId)
  const by = Object.fromEntries(rows.map((r) => [r.status, r]))
  const earned = (by.completed?.commission ?? 0)
  const billed = (by.billed?.commission ?? 0)
  const paid = (by.paid?.commission ?? 0)
  return { by, earned, billed, paid, open: earned + billed }
}

// ---- billing a month --------------------------------------------------------

/**
 * One invoice for everything completed in a month, one line per case.
 *
 * Idempotent on the period: run it twice and the second run finds the cases
 * already marked billed and does nothing. A case completed after the invoice
 * went out lands in the next month rather than reopening a sent invoice.
 */
export async function billMonth(db, {
  entity_id, agreement_id, period, issue_date = null, posted_by = null, issue_it = true,
}) {
  const agreement = await db.get('SELECT * FROM referral_agreement WHERE id = ?', agreement_id)
  if (!agreement) throw new Error('No such agreement.')
  const cases = await db.all(
    `SELECT * FROM referral
      WHERE entity_id = ? AND agreement_id = ? AND status = 'completed'
        AND substr(completed_on,1,7) = ?
      ORDER BY completed_on, sent_on`,
    entity_id, agreement_id, period)
  if (!cases.length) return { doc: null, cases: [] }

  const on = issue_date || `${period}-01`
  const account = await db.get(
    'SELECT id FROM account WHERE entity_id = ? AND code = ?', entity_id, agreement.account_code)

  const doc = await draft(db, {
    entity_id,
    kind: 'invoice',
    party_id: agreement.party_id,
    project_id: agreement.project_id,
    issue_date: on,
    due_date: addDays(on, agreement.terms_days),
    wht_bp: agreement.wht_bp,
    currency: agreement.currency,
    subject_en: `${agreement.name_en} — ${period}`,
    subject_th: agreement.name_th ? `${agreement.name_th} — ${period}` : null,
    idem_key: `referral:${agreement_id}:${period}`,
    lines: cases.map((c) => ({
      desc_en: lineFor(c, agreement, 'en'),
      desc_th: lineFor(c, agreement, 'th'),
      unit_price: c.commission ?? 0,
      tax_code: 'VAT7',
      account_id: account?.id ?? null,
      project_id: agreement.project_id,
    })),
  })
  const out = issue_it && doc.status === 'draft' ? await issue(db, doc.id, { posted_by }) : doc

  for (const c of cases) {
    await db.run(
      "UPDATE referral SET status = 'billed', doc_id = ?, billed_period = ? WHERE id = ?",
      out.id, period, c.id)
  }
  await record(db, {
    entity_id, person_id: posted_by, action: 'referral.billed', object_id: agreement.code,
    detail: { period, cases: cases.length, doc: out.number, total: out.gross },
  })
  return { doc: out, cases }
}

/**
 * A resold case, billed both ways: the client is invoiced at what they were
 * quoted, and the desk that does the work is recorded as the cost of it.
 *
 * The margin is then gross profit in the books — revenue less cost of sales —
 * rather than a commission anybody has to ask for. Both documents carry the
 * case's own reference so the pair can be found again.
 */
export async function billClient(db, referralId, {
  issue_date = null, posted_by = null, project_id = null, vat = true,
}) {
  const r = await db.get('SELECT * FROM referral WHERE id = ?', referralId)
  if (!r) throw new Error('No such referral.')
  if (!r.client_party_id) throw new Error('This case has no client on it.')
  if (r.client_doc_id) return db.get('SELECT * FROM doc WHERE id = ?', r.client_doc_id)
  if (!r.case_fee) throw new Error('This case has no price yet.')

  const agreement = r.agreement_id
    ? await db.get('SELECT * FROM referral_agreement WHERE id = ?', r.agreement_id)
    : null
  const on = issue_date || r.completed_on || r.sent_on
  const revenue = await accountByCode(db, r.entity_id, '4100')
  const doc = await issue(db, (await draft(db, {
    entity_id: r.entity_id,
    kind: 'invoice',
    party_id: r.client_party_id,
    project_id: project_id || agreement?.project_id || null,
    issue_date: on,
    due_date: on,
    subject_en: r.label || r.service,
    idem_key: `referral:client:${r.id}`,
    lines: [{
      desc_en: r.label || r.service || 'Service',
      unit_price: r.case_fee,
      tax_code: vat ? 'VAT7' : 'NONE',
      account_id: revenue?.id ?? null,
      project_id: project_id || agreement?.project_id || null,
    }],
  })).id, { posted_by })
  await db.run('UPDATE referral SET client_doc_id = ? WHERE id = ?', doc.id, referralId)
  return doc
}

/**
 * What the desk that did the work charges, for a month of cases: one bill with
 * a line each, which is how they send it.
 */
export async function billNetMonth(db, {
  entity_id, agreement_id, period, issue_date = null, posted_by = null, vat = true,
}) {
  const agreement = await db.get('SELECT * FROM referral_agreement WHERE id = ?', agreement_id)
  if (!agreement) throw new Error('No such agreement.')
  const cases = await db.all(
    `SELECT * FROM referral
      WHERE entity_id = ? AND agreement_id = ? AND net_doc_id IS NULL
        AND net_cost > 0 AND status IN ('completed','billed','paid')
        AND substr(completed_on,1,7) = ?
      ORDER BY completed_on`, entity_id, agreement_id, period)
  if (!cases.length) return { doc: null, cases: [] }

  const on = issue_date || `${period}-01`
  const cogs = await accountByCode(db, entity_id, '5000')
  const bill = await issue(db, (await draft(db, {
    entity_id,
    kind: 'bill',
    party_id: agreement.party_id,
    project_id: agreement.project_id,
    issue_date: on,
    due_date: on,
    currency: agreement.currency,
    subject_en: `${agreement.name_en} — ${period}`,
    idem_key: `referral:net:${agreement_id}:${period}`,
    lines: cases.map((c) => ({
      desc_en: `${c.label || c.external_id || 'Case'} · ${c.completed_on}`,
      unit_price: c.net_cost,
      tax_code: vat ? 'VAT7' : 'NONE',
      account_id: cogs?.id ?? null,
      project_id: agreement.project_id,
    })),
  })).id, { posted_by })

  for (const c of cases) {
    await db.run('UPDATE referral SET net_doc_id = ? WHERE id = ?', bill.id, c.id)
  }
  await record(db, {
    entity_id, person_id: posted_by, action: 'referral.net_billed', object_id: agreement.code,
    detail: { period, cases: cases.length, doc: bill.number, total: bill.gross },
  })
  return { doc: bill, cases }
}

/** The invoice line for one case: what it was, and how the number was reached. */
function lineFor(c, agreement, locale) {
  const label = c.label || c.service || c.external_id || 'Referral'
  const when = c.completed_on || c.sent_on
  if (c.basis_used === 'margin') {
    return locale === 'th'
      ? `${label} · ${when} · ส่วนต่างจากราคาที่ตกลง`
      : `${label} · ${when} · the quoted price less the net price`
  }
  if (c.basis_used === 'fixed_per_case') {
    return locale === 'th'
      ? `${label} · ${when} · ค่าแนะนำต่อเคส`
      : `${label} · ${when} · fee per completed case`
  }
  const pct = (c.rate_used_bp ?? 0) / 100
  return locale === 'th'
    ? `${label} · ${when} · ${pct}% ของค่าบริการ`
    : `${label} · ${when} · ${pct}% of the fee`
}

/** Mark the cases on a paid invoice as paid, so the pipeline agrees with the
 *  bank rather than with the invoice. */
export async function markPaidFromDoc(db, docId) {
  const doc = await db.get('SELECT * FROM doc WHERE id = ?', docId)
  if (!doc || doc.status !== 'paid') return 0
  const r = await db.run("UPDATE referral SET status = 'paid' WHERE doc_id = ?", docId)
  return r.changes
}

// ---- reading it against theirs ----------------------------------------------

/**
 * Compare our completed cases with the other side's statement.
 *
 * `theirs` is [{ external_id, label, case_fee, commission }] — whatever they
 * sent, parsed by the caller. Returns three lists: agreed, differing, and on
 * one side only. The point is that the conversation is about named rows.
 */
export function reconcile(ours, theirs) {
  const key = (r) => String(r.external_id || r.label || '').trim().toLowerCase()
  const mine = new Map(ours.map((r) => [key(r), r]))
  const agreed = []
  const differs = []
  const theirsOnly = []
  for (const t of theirs) {
    const k = key(t)
    const m = mine.get(k)
    if (!m) { theirsOnly.push(t); continue }
    mine.delete(k)
    const sameFee = t.case_fee == null || m.case_fee == null || t.case_fee === m.case_fee
    const sameCommission = t.commission == null || t.commission === m.commission
    if (sameFee && sameCommission) agreed.push({ ...m, theirs: t })
    else differs.push({ ...m, theirs: t })
  }
  return { agreed, differs, oursOnly: [...mine.values()], theirsOnly }
}

// ---- importing what another system already captured -------------------------

/**
 * Take rows from the desk's own enquiry table and make referrals of them.
 *
 * The mapping is deliberately narrow: an id, a date, a code, a service label,
 * and a fee when the other side has filled one in. Contact details are left
 * where they are.
 */
export async function importEnquiries(db, { entity_id, rows, code = null, map = {} }) {
  const made = []
  for (const row of rows) {
    const external_id = String(row[map.id || 'idem'] ?? row.id ?? '').trim()
    if (!external_id) continue
    const sent_on = String(row[map.date || 'received_at'] ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sent_on)) continue
    const rowCode = code || row[map.code || 'origin'] || row.ref || null
    const agreement = rowCode ? await agreementOn(db, entity_id, rowCode, sent_on) : null
    const ref = await addReferral(db, {
      entity_id,
      code: rowCode,
      agreement_id: agreement?.id ?? null,
      external_id,
      sent_on,
      label: row[map.label || 'visa'] || row.need || null,
      service: row[map.service || 'need'] || null,
      channel: 'site',
      case_fee: parseFee(row[map.fee || 'fee']),
      note: row[map.note || 'line'] ? `line ${row[map.note || 'line']}` : null,
    })
    // The desk marks an enquiry booked; that is the other side accepting it.
    if (Number(row.booked) === 1 && ref.status === 'sent') {
      await setStatus(db, ref.id, { status: 'accepted', on_date: sent_on })
    }
    made.push(ref)
  }
  return made
}

const parseFee = (v) => {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
