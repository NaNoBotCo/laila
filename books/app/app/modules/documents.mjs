// documents.mjs — quotations, invoices, tax invoices, supplier bills, credit
// notes, and the payments that settle them.
//
// A document has two lives. As a DRAFT it can be edited freely and touches
// nothing. Once ISSUED it has a number in a sequence, a journal behind it, and
// it stops being editable: a wrong issued invoice is cancelled by a credit
// note and re-issued. That is the shape a tax officer reads, and it is also
// the only way the ledger and the paper can be relied on to say the same
// thing.
//
// Withholding is the Thai-specific bit. A ฿100 service invoice with 7% VAT is
// ฿107 gross, and a company customer pays ฿104 — withholding ฿3 and sending a
// certificate. So `expect_paid` is what to watch the bank for, and the ฿3
// lands in "withholding tax suffered", an asset, until it is set against the
// year's tax.

import { uid, nextNumber } from '../lib/ids.mjs'
import { pct } from '../lib/money.mjs'
import { vatBpOn } from '../lib/tax.mjs'
import { rateOn as fxRateOn, convertMoney, PPM } from '../lib/fx.mjs'
import { post, accountBySubtype, accountByCode, PostingError } from './books.mjs'
import { invoiceDefaults, treatmentNote } from './parties.mjs'

const SALES_KINDS = new Set(['quote', 'invoice', 'tax_invoice', 'receipt'])

export const TAX_BP = { VAT7: 700, ZERO: 0, EXEMPT: 0, NONE: 0 }

/** Line arithmetic, in the document's currency. Quantities are thousandths,
 *  so half a day is exact and a third of an hour rounds once, here. */
export function lineTotals(line, { vatBp = 700 } = {}) {
  const qty = Math.trunc(line.qty_milli ?? 1000)
  const gross = Math.round((qty * Math.trunc(line.unit_price || 0)) / 1000)
  const net = gross - Math.trunc(line.discount || 0)
  const rate = line.tax_code === 'VAT7' ? vatBp : (TAX_BP[line.tax_code] ?? 0)
  return { net, vat: pct(net, rate) }
}

export function documentTotals(lines, { vatBp = 700, whtBp = 0 } = {}) {
  let net = 0
  let vat = 0
  for (const l of lines) {
    const t = lineTotals(l, { vatBp })
    net += t.net
    vat += t.vat
  }
  // Withholding is computed on the amount before VAT.
  const wht = whtBp ? pct(net, whtBp) : 0
  const gross = net + vat
  return { net, vat, gross, wht, expect_paid: gross - wht }
}

/**
 * Create a draft. Lines carry their own revenue or expense account; a line
 * without one falls back to the entity's default for the direction, so a quick
 * invoice does not stall on account choice.
 */
export async function draft(db, {
  entity_id, kind, party_id, project_id = null, issue_date, due_date = null, direction = null,
  currency = null, fx_rate_ppm = null, wht_bp = null, lines = [],
  subject_en = null, subject_th = null, subject_km = null,
  note_en = null, note_th = null, note_km = null,
  ref_external = null, idem_key = null, vat_bp = null,
}) {
  if (idem_key) {
    const seen = await db.get('SELECT * FROM doc WHERE idem_key = ?', idem_key)
    if (seen) return withLines(db, seen)
  }
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entity_id)
  // What the customer implies: their currency, whether they withhold, whether
  // the work is zero-rated. Anything passed in wins; this only fills blanks.
  const byParty = await invoiceDefaults(db, { entity_id, party_id, entity })
  // Left unsaid, a document is in the currency these books are kept in — riel
  // in Phnom Penh, baht in Chiang Mai — and never a default from the code.
  const ccy = currency || byParty.currency || entity?.currency || 'THB'
  // A credit note follows the document it corrects rather than its own kind:
  // cancelling a sales invoice is an outbound document, cancelling a supplier
  // bill an inbound one, and the caller knows which.
  const dir = direction || (SALES_KINDS.has(kind) ? 'out' : 'in')
  // An entity that is not VAT registered does not charge VAT, whatever a line
  // says — which keeps a copied template from inventing a tax registration.
  // The rate itself comes from the dated rate table, read at the document's own
  // date, so a change of rate applies from the day it applies and not before.
  const vatBp = vat_bp ?? ((entity?.vat_registered && byParty.charges_vat)
    ? await vatBpOn(db, issue_date, String(entity.country || 'TH').toUpperCase())
    : 0)
  // Withholding is what a local company does to a local supplier. A foreign
  // customer sends the whole amount, so expecting 97% of it would leave every
  // invoice looking short-paid. It is applied here only where the customer
  // record says so outright: an inference belongs on the form, where somebody
  // can see it and disagree, not in a posted total.
  const whtBp = wht_bp ?? (byParty.withholds_from === 'set' && byParty.withholds
    && dir === 'out' && kind !== 'quote'
    ? await defaultWhtBp(db, entity, issue_date) : 0)
  const totals = documentTotals(lines, { vatBp, whtBp })
  // Why no VAT, in the customer's own language, on the paper they receive.
  const treatNote = byParty.charges_vat ? null : (byParty.note_tax
    || treatmentNote(byParty.tax_treatment, byParty.locale))

  const id = uid()
  await db.run(
    `INSERT INTO doc(id, entity_id, kind, direction, number, party_id, project_id,
       issue_date, due_date, currency, fx_rate_ppm, net, vat, gross, wht_bp, wht,
       expect_paid, status, subject_en, subject_th, subject_km, note_en, note_th,
       note_km, ref_external, idem_key, vat_bp)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)`,
    id, entity_id, kind, dir, `draft:${id.slice(0, 8)}`, party_id, project_id,
    issue_date, due_date, ccy, fx_rate_ppm, totals.net, totals.vat, totals.gross,
    whtBp, totals.wht, totals.expect_paid, subject_en, subject_th, subject_km,
    note_en ?? treatNote, note_th, note_km, ref_external, idem_key, vatBp)

  let seq = 0
  for (const l of lines) {
    const t = lineTotals(l, { vatBp })
    await db.run(
      `INSERT INTO doc_line(id, doc_id, seq, desc_en, desc_th, desc_km, qty_milli, unit,
         unit_price, discount, tax_code, account_id, project_id, item_id, net, vat)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), id, seq++, l.desc_en, l.desc_th ?? null, l.desc_km ?? null,
      l.qty_milli ?? 1000, l.unit ?? null,
      l.unit_price ?? 0, l.discount ?? 0, l.tax_code ?? 'NONE', l.account_id ?? null,
      l.project_id ?? project_id ?? null, l.item_id ?? null, t.net, t.vat)
  }
  return withLines(db, await db.get('SELECT * FROM doc WHERE id = ?', id))
}

/** The service withholding rate in force for these books, from the rate table
 *  rather than a constant, so a change of rate is an edit and not a release. */
async function defaultWhtBp(db, entity, onDate) {
  const jur = String(entity?.country || 'TH').toUpperCase()
  const row = await db.get(
    `SELECT value_bp FROM rate WHERE jur = ? AND scope = 'wht' AND code = 'service'
       AND from_date <= ? AND (to_date IS NULL OR to_date >= ?)
     ORDER BY from_date DESC LIMIT 1`, jur, onDate, onDate)
  return row?.value_bp ?? 0
}

async function withLines(db, doc) {
  if (!doc) return null
  return { ...doc, lines: await db.all('SELECT * FROM doc_line WHERE doc_id = ? ORDER BY seq', doc.id) }
}

export const getDoc = async (db, id) =>
  withLines(db, await db.get('SELECT * FROM doc WHERE id = ?', id))

/**
 * Issue a draft: give it its number and post it.
 *
 * A quotation is issued without a journal — it promises nothing and owes
 * nothing until it is accepted and becomes an invoice.
 */
export async function issue(db, docId, { posted_by = null } = {}) {
  const doc = await getDoc(db, docId)
  if (!doc) throw new PostingError('not_found', 'No such document.')
  if (doc.status !== 'draft') throw new PostingError('already_issued', 'Already issued.')

  const year = Number(doc.issue_date.slice(0, 4))
  const number = await nextNumber(db, doc.entity_id, doc.kind, year)
  await db.run(
    `UPDATE doc SET number = ?, status = 'issued',
       issued_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`, number, docId)

  // A quotation promises nothing until it is accepted, and a document that
  // comes to zero — a free seat, a sample, a goodwill replacement — is a record
  // rather than a transaction. Both are issued; neither moves an account.
  if (doc.kind === 'quote' || (doc.net === 0 && doc.vat === 0)) return getDoc(db, docId)

  const journal = await postDocument(db, { ...doc, number }, posted_by)
  await db.run('UPDATE doc SET journal_id = ? WHERE id = ?', journal.id, docId)

  // An invoice going out gets its payment link and, when there is a way to be
  // paid by transfer, its satang tail — so the payer has nothing to type and a
  // bank credit says which invoice it belongs to. Imported lazily: the books
  // work without ever being paid by transfer.
  if (doc.direction === 'out') {
    const { preparePayment } = await import('./paying.mjs')
    await preparePayment(db, docId)
  }
  return getDoc(db, docId)
}

async function defaultAccount(db, entityId, direction) {
  return direction === 'out'
    ? (await accountByCode(db, entityId, '4100')) || (await accountByCode(db, entityId, '4000'))
    : (await accountByCode(db, entityId, '6900'))
}

/** The journal a document implies. Sales debit the customer and credit
 *  revenue; purchases debit the cost and credit the supplier. */
async function postDocument(db, doc, posted_by) {
  const out = doc.direction === 'out'
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', doc.entity_id)
  const control = await accountBySubtype(db, doc.entity_id, out ? 'ar' : 'ap')
  const vatAcct = await accountBySubtype(db, doc.entity_id, out ? 'vat_out' : 'vat_in')
  const fallback = await defaultAccount(db, doc.entity_id, doc.direction)
  const sign = out ? 1 : -1                     // debit the customer, credit the supplier

  // The books add up in one currency. A document in another is converted at the
  // rate on its own date — kept on the document, so the invoice still says what
  // the customer was asked for and the ledger still adds up.
  const books = entity?.currency || 'THB'
  const foreign = doc.currency && doc.currency !== books
  let ratePpm = doc.fx_rate_ppm ?? null
  if (foreign && !ratePpm) {
    const found = await fxRateOn(db, doc.currency, books, doc.issue_date, { through: books })
    if (!found) {
      throw new PostingError('no_fx_rate',
        `No rate for ${doc.currency} to ${books} on ${doc.issue_date}.`,
        { from: doc.currency, to: books, on: doc.issue_date })
    }
    ratePpm = found.rate_ppm
    await db.run('UPDATE doc SET fx_rate_ppm = ? WHERE id = ?', ratePpm, doc.id)
  }
  const inBooks = (amount) => (foreign ? convertMoney(amount, ratePpm, doc.currency, books) : amount)
  const carried = (amount) => (foreign
    ? { currency: doc.currency, fx_amount: amount, fx_rate_ppm: ratePpm }
    : { currency: books })

  const lines = [{
    account: control.id,
    amount: sign * inBooks(doc.gross),
    party_id: doc.party_id,
    project_id: doc.project_id,
    ...carried(sign * doc.gross),
    memo: doc.subject_en,
  }]
  for (const l of doc.lines) {
    if (!l.net) continue
    lines.push({
      account: l.account_id || fallback.id,
      amount: -sign * inBooks(l.net),
      party_id: doc.party_id,
      project_id: l.project_id || doc.project_id,
      tax_code: l.tax_code,
      ...carried(-sign * l.net),
      memo: l.desc_en,
    })
  }
  if (doc.vat) {
    lines.push({
      account: vatAcct.id,
      amount: -sign * inBooks(doc.vat),
      party_id: doc.party_id,
      ...carried(-sign * doc.vat),
      tax_code: 'VAT7',
      memo: 'VAT',
    })
  }

  // Rounding a converted total and its parts separately can leave a satang
  // between them; it goes on the control line, where the customer's balance is
  // the figure that must be exact.
  const drift = lines.reduce((a, l) => a + l.amount, 0)
  if (drift) lines[0].amount -= drift

  return post(db, {
    entity_id: doc.entity_id,
    on_date: doc.issue_date,
    memo_en: `${doc.kind} ${doc.number}`,
    memo_th: null,
    source_kind: 'doc',
    source_id: doc.id,
    idem_key: `doc:${doc.id}`,
    posted_by,
    lines,
  })
}

/**
 * Cancel an issued document with a credit note. The original keeps its number
 * and its journal; the credit note carries the opposite entries and both stay
 * in the sequence.
 */
export async function voidWithCreditNote(db, docId, { issue_date, reason_en = null, posted_by = null } = {}) {
  const doc = await getDoc(db, docId)
  if (!doc) throw new PostingError('not_found', 'No such document.')
  if (doc.status === 'draft') {
    await db.run("UPDATE doc SET status = 'void' WHERE id = ?", docId)
    return null
  }
  const cn = await draft(db, {
    entity_id: doc.entity_id,
    kind: 'credit_note',
    direction: doc.direction,
    party_id: doc.party_id,
    project_id: doc.project_id,
    issue_date: issue_date || doc.issue_date,
    currency: doc.currency,
    wht_bp: doc.wht_bp,
    subject_en: reason_en || `Cancels ${doc.number}`,
    lines: doc.lines.map((l) => ({
      desc_en: l.desc_en, desc_th: l.desc_th, desc_km: l.desc_km,
      qty_milli: l.qty_milli, unit: l.unit,
      unit_price: -l.unit_price, discount: -l.discount, tax_code: l.tax_code,
      account_id: l.account_id, project_id: l.project_id,
    })),
  })
  const issued = await issue(db, cn.id, { posted_by })
  await db.run("UPDATE doc SET status = 'void', voided_by = ? WHERE id = ?", issued.id, docId)
  return issued
}

// ---- payments --------------------------------------------------------------

/**
 * Record money in or out, and what it settles.
 *
 * `allocations` is [{ doc_id, amount, wht_amount }]. The certificate portion
 * settles the document as surely as the cash does, so both are allocated and
 * the document closes when cash + certificate meet the total.
 */
export async function recordPayment(db, {
  entity_id, direction, on_date, party_id = null, account, method = 'transfer',
  currency = null, amount, wht_amount = 0, fee = 0, slip_ref = null,
  wht_cert_no = null, note = null, idem_key = null, posted_by = null,
  allocations = [],
}) {
  if (idem_key) {
    const seen = await db.get('SELECT * FROM payment WHERE idem_key = ?', idem_key)
    if (seen) return seen
  }
  const books = await db.get('SELECT currency FROM entity WHERE id = ?', entity_id)
  const ccy = currency || books?.currency || 'THB'
  const bank = typeof account === 'object' ? account
    : (await accountByCode(db, entity_id, account)) ||
      (await accountBySubtype(db, entity_id, 'cash'))
  if (!bank) throw new PostingError('no_account', 'No cash or bank account to post to.')

  const inbound = direction === 'in'
  const allocTotal = allocations.reduce((a, x) => a + (x.amount || 0) + (x.wht_amount || 0), 0)
  for (const a of allocations) {
    const d = await db.get('SELECT * FROM doc WHERE id = ?', a.doc_id)
    if (!d) throw new PostingError('not_found', `No document ${a.doc_id}.`)
    const outstanding = d.gross - d.paid - d.wht_credited
    const applying = (a.amount || 0) + (a.wht_amount || 0)
    if (applying > outstanding) {
      throw new PostingError('over_allocate',
        `${d.number} has ${outstanding} outstanding; ${applying} offered.`,
        { doc: d.number, outstanding, applying })
    }
  }

  const id = uid()
  await db.run(
    `INSERT INTO payment(id, entity_id, direction, on_date, party_id, account_id,
       method, currency, amount, wht_amount, fee, slip_ref, wht_cert_no, note, idem_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, direction, on_date, party_id, bank.id, method, ccy,
    amount, wht_amount, fee, slip_ref, wht_cert_no, note, idem_key)
  // Filled in below, once the rate for the day is known.

  for (const a of allocations) {
    await db.run(
      'INSERT INTO allocation(id, payment_id, doc_id, amount, wht_amount) VALUES (?,?,?,?,?)',
      uid(), id, a.doc_id, a.amount || 0, a.wht_amount || 0)
    await db.run(
      `UPDATE doc SET paid = paid + ?, wht_credited = wht_credited + ?,
         status = CASE WHEN paid + ? + wht_credited + ? >= gross THEN 'paid'
                       ELSE 'part_paid' END
       WHERE id = ?`,
      a.amount || 0, a.wht_amount || 0, a.amount || 0, a.wht_amount || 0, a.doc_id)
  }

  const control = await accountBySubtype(db, entity_id, inbound ? 'ar' : 'ap')
  const whtSuffered = await accountBySubtype(db, entity_id, 'wht_recv')
  const whtPayable = await accountBySubtype(db, entity_id, 'wht_pay')
  const feeAcct = await accountByCode(db, entity_id, '6500')
  const fxAcct = await accountByCode(db, entity_id, '7000')

  // Money that moved in one currency settling a debt recorded in another. The
  // bank side converts at today's rate, the debt is relieved at the rate it was
  // recorded at, and what is left between them is a gain or a loss on the day
  // the money moved.
  const bookCcy = books?.currency || 'THB'
  let payRate = PPM
  if (ccy && ccy !== bookCcy) {
    const found = await fxRateOn(db, ccy, bookCcy, on_date, { through: bookCcy })
    if (!found) {
      throw new PostingError('no_fx_rate', `No rate for ${ccy} to ${bookCcy} on ${on_date}.`)
    }
    payRate = found.rate_ppm
  }
  const inBooks = (v) => (payRate === PPM ? v : convertMoney(v, payRate, ccy, bookCcy))

  let relieved = 0
  for (const a of allocations) {
    const d = await db.get('SELECT * FROM doc WHERE id = ?', a.doc_id)
    const docRate = !d.currency || d.currency === bookCcy ? PPM : (d.fx_rate_ppm || payRate)
    const applied = (a.amount || 0) + (a.wht_amount || 0)
    relieved += docRate === PPM ? applied : convertMoney(applied, docRate, d.currency, bookCcy)
  }

  const foreign = payRate !== PPM
  const carried = (v) => (foreign
    ? { currency: ccy, fx_amount: v, fx_rate_ppm: payRate }
    : { currency: ccy })

  const lines = []
  if (inbound) {
    // Money in: the bank grows, the certificate becomes an asset, the bank's
    // cut is an expense, and the customer's balance falls by what was owed —
    // at the rate the debt was recorded at, not today's.
    lines.push({ account: bank.id, amount: inBooks(amount), party_id, ...carried(amount), memo: slip_ref })
    if (wht_amount) {
      lines.push({
        account: whtSuffered.id, amount: inBooks(wht_amount), party_id, memo: wht_cert_no,
      })
    }
    if (fee) lines.push({ account: feeAcct.id, amount: inBooks(fee) })
    const relief = relieved || inBooks(amount + wht_amount + fee)
    lines.push({ account: control.id, amount: -relief, party_id })
  } else {
    // Money out: the supplier's balance falls by the invoice, the bank by what
    // actually left, and the difference is tax withheld and owed onward.
    const relief = relieved || inBooks(allocTotal || amount + wht_amount)
    lines.push({ account: control.id, amount: relief, party_id })
    if (wht_amount) {
      lines.push({
        account: whtPayable.id, amount: -inBooks(wht_amount), party_id, memo: wht_cert_no,
      })
    }
    if (fee) lines.push({ account: feeAcct.id, amount: inBooks(fee) })
    lines.push({
      account: bank.id, amount: -inBooks(amount + fee), party_id,
      ...carried(-(amount + fee)), memo: slip_ref,
    })
  }
  // Whatever the two rates leave between them is a gain or a loss, on the day
  // the money moved.
  const gap = lines.reduce((a, l) => a + l.amount, 0)
  if (gap && fxAcct) lines.push({ account: fxAcct.id, amount: -gap, memo: 'exchange difference' })

  const journal = await post(db, {
    entity_id,
    on_date,
    memo_en: inbound ? 'Payment received' : 'Payment made',
    source_kind: 'payment',
    source_id: id,
    idem_key: `payment:${id}`,
    posted_by,
    lines,
  })
  await db.run(
    'UPDATE payment SET journal_id = ?, booked_amount = ?, fx_rate_ppm = ? WHERE id = ?',
    journal.id, inBooks(amount), payRate, id)
  return db.get('SELECT * FROM payment WHERE id = ?', id)
}

/** Open documents, oldest first — who owes what, and what is owed. */
export async function openDocs(db, entityId, { direction = 'out', asOf = null } = {}) {
  const rows = await db.all(
    `SELECT d.*, p.name_en AS party_name_en, p.name_th AS party_name_th,
            p.name_km AS party_name_km
       FROM doc d JOIN party p ON p.id = d.party_id
      WHERE d.entity_id = ? AND d.direction = ?
        AND d.status IN ('issued','part_paid')
        -- A quotation is an offer, not a debt: it has a number and a total and
        -- nobody owes it. Counting one as receivable overstates the money.
        AND d.kind <> 'quote'
        AND (? IS NULL OR d.issue_date <= ?)
      ORDER BY COALESCE(d.due_date, d.issue_date)`,
    entityId, direction, asOf, asOf)
  return rows.map((r) => ({ ...r, outstanding: r.gross - r.paid - r.wht_credited }))
}

/** Ageing buckets against a date: current, 1-30, 31-60, 61-90, over 90. */
export function ageBuckets(docs, asOf) {
  const day = 86400000
  const base = Date.parse(`${asOf}T00:00:00Z`)
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, older: 0 }
  for (const d of docs) {
    const due = Date.parse(`${d.due_date || d.issue_date}T00:00:00Z`)
    const days = Math.floor((base - due) / day)
    const k = days <= 0 ? 'current' : days <= 30 ? 'd30' : days <= 60 ? 'd60'
      : days <= 90 ? 'd90' : 'older'
    buckets[k] += d.outstanding
  }
  return buckets
}
