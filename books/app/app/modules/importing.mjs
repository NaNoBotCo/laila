// importing.mjs — moving in.
//
// Somebody keeping books in Excel has three things that make changing systems
// feel impossible: the customer list, the invoices nobody has paid yet, and the
// bank. This module takes all three from whatever they already have.
//
// The rules it works under:
//
//   · READ WHAT IS THERE. Buddhist years, ฿ signs, brackets for a credit, Thai
//     or Khmer column headings, a page of preamble above the table.
//   · NOTHING POSTS ON A GUESS. Every import is previewed first — row by row,
//     with what each one will do and what could not be read.
//   · THE SAME FILE TWICE CHANGES NOTHING. A statement line is fingerprinted;
//     a contact already there is updated, not duplicated.
//   · WHAT CAME IN CAN GO BACK OUT while it has touched nothing.
//
// Opening invoices do not post as sales. Last year's unpaid invoice is not this
// year's income: it lands against "brought forward" in equity, so the trial
// balance is right on day one and the profit and loss is not flattered.

import { uid } from '../lib/ids.mjs'
import { readTable, readDate, readAmount, guessColumns } from '../lib/table.mjs'
import { post, accountByCode, accountBySubtype, PostingError } from './books.mjs'
import { addParty } from './parties.mjs'
import { matchIncoming } from './paying.mjs'
import { recordPayment } from './documents.mjs'
import { unpaidFilings, payFiling } from './compliance.mjs'

export const BROUGHT_FORWARD = '3900'

/** The equity account an opening balance lands in, made once if it is absent. */
export async function broughtForwardAccount(db, entityId) {
  const seen = await accountByCode(db, entityId, BROUGHT_FORWARD)
  if (seen) return seen
  await db.run(
    `INSERT INTO account(id, entity_id, code, name_en, name_th, name_km, type, subtype)
     VALUES (?,?,?,?,?,?,'equity',NULL)`,
    uid(), entityId, BROUGHT_FORWARD, 'Brought forward', 'ยอดยกมา', 'សមតុល្យដើមគ្រា')
  return accountByCode(db, entityId, BROUGHT_FORWARD)
}

const started = async (db, { entity_id, kind, source_name = null, person_id = null, note = null }) => {
  const id = uid()
  await db.run(
    'INSERT INTO import_batch(id, entity_id, kind, source_name, person_id, note) VALUES (?,?,?,?,?,?)',
    id, entity_id, kind, source_name, person_id, note)
  return id
}

const finished = (db, batchId, counts) =>
  db.run('UPDATE import_batch SET counts = ? WHERE id = ?', JSON.stringify(counts), batchId)

/** What the file looks like, before anybody commits to anything. */
export function look(text, fields) {
  const { headers, rows, skipped } = readTable(text)
  return { headers, rows, skipped, columns: guessColumns(headers, fields) }
}

const valueOf = (row, columns, field) => {
  const col = columns?.[field]
  return col == null ? '' : String(row[col] ?? '').trim()
}

// ---- customers and suppliers ------------------------------------------------

const CONTACT_FIELDS = ['name', 'name_local', 'tax_id', 'email', 'phone', 'address',
  'country', 'currency', 'terms_days']

/**
 * What this contact list would do, row by row: a new contact, an update to one
 * already here, or a row that cannot be used and why.
 */
export async function previewContacts(db, { entity_id, text, rows = null, columns = null }) {
  const read = rows ? { rows, columns: columns || {}, headers: [] } : look(text, CONTACT_FIELDS)
  const cols = columns || read.columns
  const here = await db.all('SELECT * FROM party WHERE entity_id = ?', entity_id)
  const byTax = new Map(here.filter((p) => p.tax_id).map((p) => [String(p.tax_id).replace(/\D/g, ''), p]))
  const byName = new Map(here.map((p) => [String(p.name_en || '').toLowerCase().trim(), p]))

  const out = []
  for (const row of read.rows) {
    const name = valueOf(row, cols, 'name')
    const local = valueOf(row, cols, 'name_local')
    const taxId = valueOf(row, cols, 'tax_id').replace(/\D/g, '')
    if (!name && !local) { out.push({ row, action: 'skip', why: 'no name' }); continue }
    const existing = (taxId && byTax.get(taxId)) || byName.get(name.toLowerCase())
    const terms = valueOf(row, cols, 'terms_days')
    out.push({
      row,
      action: existing ? 'update' : 'create',
      existing: existing || null,
      party: {
        name_en: name || local,
        name_th: local || null,
        tax_id: taxId || null,
        email: valueOf(row, cols, 'email') || null,
        phone: valueOf(row, cols, 'phone') || null,
        address_en: valueOf(row, cols, 'address') || null,
        country: (valueOf(row, cols, 'country') || '').toUpperCase().slice(0, 2) || null,
        currency: (valueOf(row, cols, 'currency') || '').toUpperCase() || null,
        terms_days: /^\d+$/.test(terms) ? Number(terms) : 0,
        // A tax id means a registered company here; anybody else is a person
        // until somebody says otherwise.
        is_company: taxId ? 1 : 0,
      },
    })
  }
  return { ...read, columns: cols, plan: out }
}

export async function importContacts(db, opts) {
  const { entity_id, source_name = null, person_id = null } = opts
  const { plan, columns, headers } = await previewContacts(db, opts)
  const batch = await started(db, { entity_id, kind: 'contacts', source_name, person_id })
  let created = 0
  let updated = 0
  let skipped = 0
  for (const item of plan) {
    if (item.action === 'skip') { skipped++; continue }
    if (item.action === 'update') {
      const set = Object.entries(item.party)
        .filter(([, v]) => v != null && v !== '' && v !== 0)
        .filter(([k]) => k !== 'is_company')
      if (set.length) {
        await db.run(
          `UPDATE party SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
          ...set.map(([, v]) => v), item.existing.id)
      }
      updated++
      continue
    }
    const made = await addParty(db, {
      entity_id,
      ...item.party,
      country: item.party.country || undefined,
    })
    await db.run('UPDATE party SET import_batch = ? WHERE id = ?', batch, made.id)
    created++
  }
  const counts = { created, updated, skipped }
  await finished(db, batch, counts)
  return { batch_id: batch, columns, headers, ...counts }
}

/** Take a contact import back out, while nothing has used it. */
export async function undoContacts(db, batchId) {
  const rows = await db.all('SELECT * FROM party WHERE import_batch = ?', batchId)
  let removed = 0
  let kept = 0
  for (const p of rows) {
    const used = await db.get(
      `SELECT (SELECT COUNT(*) FROM doc WHERE party_id = ?) +
              (SELECT COUNT(*) FROM payment WHERE party_id = ?) +
              (SELECT COUNT(*) FROM journal_line WHERE party_id = ?) AS n`,
      p.id, p.id, p.id)
    if (used?.n) { kept++; continue }
    await db.run('DELETE FROM party WHERE id = ?', p.id)
    removed++
  }
  return { removed, kept }
}

// ---- the invoices nobody has paid yet ---------------------------------------

const INVOICE_FIELDS = ['number', 'name', 'date', 'due_date', 'amount', 'outstanding',
  'currency', 'description']

export async function previewOpenInvoices(db, { entity_id, text, rows = null, columns = null, direction = 'out' }) {
  const read = rows ? { rows, columns: columns || {}, headers: [] } : look(text, INVOICE_FIELDS)
  const cols = columns || read.columns
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entity_id)
  const here = await db.all('SELECT * FROM party WHERE entity_id = ?', entity_id)
  const byName = new Map(here.map((p) => [String(p.name_en || '').toLowerCase().trim(), p]))
  const byLocal = new Map(here.filter((p) => p.name_th)
    .map((p) => [String(p.name_th).trim(), p]))
  const seen = new Set((await db.all(
    'SELECT number FROM doc WHERE entity_id = ?', entity_id)).map((d) => d.number))

  const plan = []
  for (const row of read.rows) {
    const who = valueOf(row, cols, 'name')
    const ccy = (valueOf(row, cols, 'currency') || entity?.currency || 'THB').toUpperCase()
    const amount = readAmount(valueOf(row, cols, 'outstanding') || valueOf(row, cols, 'amount'), ccy)
    const date = readDate(valueOf(row, cols, 'date'))
    const number = valueOf(row, cols, 'number') || null
    const party = byName.get(who.toLowerCase()) || byLocal.get(who) || null
    let why = null
    if (!who) why = 'no customer name'
    else if (amount == null) why = 'could not read the amount'
    else if (!amount) why = 'nothing outstanding'
    else if (!date) why = 'could not read the date'
    else if (number && seen.has(number)) why = 'already here'
    plan.push({
      row,
      action: why ? 'skip' : (party ? 'invoice' : 'invoice+contact'),
      why,
      party,
      doc: why ? null : {
        number,
        party_name: who,
        issue_date: date,
        due_date: readDate(valueOf(row, cols, 'due_date')) || date,
        amount,
        currency: ccy,
        subject_en: valueOf(row, cols, 'description') || 'Brought forward',
        direction,
      },
    })
  }
  return { ...read, columns: cols, plan }
}

/**
 * Bring in what is owed, both ways.
 *
 * Each one becomes an issued document with its original number and date, and a
 * journal that debits the customer and credits "brought forward" — the amount
 * is a balance being carried in, not a sale being made today.
 */
export async function importOpenInvoices(db, opts) {
  const { entity_id, source_name = null, person_id = null, direction = 'out' } = opts
  const { plan, columns, headers } = await previewOpenInvoices(db, opts)
  const batch = await started(db, {
    entity_id, kind: direction === 'out' ? 'invoices' : 'bills', source_name, person_id,
  })
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entity_id)
  const bf = await broughtForwardAccount(db, entity_id)
  const control = await accountBySubtype(db, entity_id, direction === 'out' ? 'ar' : 'ap')
  if (!control) throw new PostingError('no_control', 'These books have no receivables account.')

  let made = 0
  let contacts = 0
  let skipped = 0
  for (const item of plan) {
    if (item.action === 'skip') { skipped++; continue }
    let party = item.party
    if (!party) {
      party = await addParty(db, {
        entity_id,
        name_en: item.doc.party_name,
        kind: direction === 'out' ? 'customer' : 'supplier',
      })
      await db.run('UPDATE party SET import_batch = ? WHERE id = ?', batch, party.id)
      contacts++
    }
    const id = uid()
    const number = item.doc.number || `BF-${String(made + 1).padStart(4, '0')}`
    await db.run(
      `INSERT INTO doc(id, entity_id, kind, direction, number, party_id, issue_date, due_date,
         currency, net, vat, gross, wht_bp, wht, expect_paid, status, subject_en, note_en,
         import_batch)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,0,0,?,'issued',?,?,?)`,
      id, entity_id, direction === 'out' ? 'invoice' : 'bill', direction, number, party.id,
      item.doc.issue_date, item.doc.due_date, item.doc.currency, item.doc.amount,
      item.doc.amount, item.doc.amount, item.doc.subject_en,
      `Brought in from ${source_name || 'a file'} as an opening balance.`, batch)

    // The signs: what a customer owes is an asset, what you owe a supplier is a
    // liability, and the other side is equity carried in either way.
    const sign = direction === 'out' ? 1 : -1
    const booked = item.doc.amount
    const journal = await post(db, {
      entity_id,
      on_date: item.doc.issue_date,
      memo_en: `Opening balance · ${number}`,
      source_kind: 'import',
      source_id: id,
      idem_key: `import:${batch}:${id}`,
      lines: [
        { account: control.id, amount: sign * booked, party_id: party.id },
        { account: bf.id, amount: -sign * booked },
      ],
    })
    await db.run('UPDATE doc SET journal_id = ? WHERE id = ?', journal.id, id)
    made++
  }
  const counts = { documents: made, contacts, skipped }
  await finished(db, batch, counts)
  return { batch_id: batch, columns, headers, ...counts }
}

/**
 * What was in the bank on the day the books start.
 *
 * One posting: the balance against brought forward. Run twice with a different
 * figure it corrects itself, because the key is the account and the date.
 */
export async function setOpeningBalance(db, {
  entity_id, account_code = '1010', amount, on_date, person_id = null,
}) {
  const account = await accountByCode(db, entity_id, account_code)
  if (!account) throw new PostingError('no_account', `No account ${account_code} in these books.`)
  const bf = await broughtForwardAccount(db, entity_id)
  // Typed again with a different figure, the difference is posted rather than
  // the first entry rewritten: the ledger only ever gains lines, and what was
  // entered on Tuesday is still what was entered on Tuesday.
  const sofar = await db.get(
    `SELECT COALESCE(SUM(l.amount),0) AS n, COUNT(DISTINCT j.id) AS runs
       FROM journal_line l JOIN journal j ON j.id = l.journal_id
      WHERE j.entity_id = ? AND j.source_kind = 'import' AND j.on_date = ?
        AND l.account_id = ? AND j.idem_key LIKE ?`,
    entity_id, on_date, account.id, `opening:${account.id}:${on_date}%`)
  const delta = amount - (sofar?.n ?? 0)
  if (!delta) return null
  return post(db, {
    entity_id,
    on_date,
    memo_en: `Opening balance · ${account.name_en}`,
    source_kind: 'import',
    idem_key: `opening:${account.id}:${on_date}:${sofar?.runs ?? 0}`,
    posted_by: person_id,
    lines: [
      { account: account.id, amount: delta },
      { account: bf.id, amount: -delta },
    ],
  })
}

// ---- the bank statement -----------------------------------------------------

const STATEMENT_FIELDS = ['date', 'description', 'debit', 'credit', 'amount', 'balance', 'number']

const fingerprintOf = (accountId, line) =>
  [accountId, line.on_date, line.amount, line.balance ?? '', (line.description || '').slice(0, 60)]
    .join('|')

/** The statement as lines, before any of it is written down. */
export async function previewStatement(db, { entity_id, account_code = '1010', text, rows = null, columns = null }) {
  const read = rows ? { rows, columns: columns || {}, headers: [] } : look(text, STATEMENT_FIELDS)
  const cols = columns || read.columns
  const account = await accountByCode(db, entity_id, account_code)
  const ccy = account?.currency || (await db.get('SELECT currency FROM entity WHERE id = ?', entity_id))?.currency || 'THB'
  const known = new Set((await db.all(
    'SELECT fingerprint FROM bank_line WHERE entity_id = ?', entity_id)).map((r) => r.fingerprint))

  const plan = []
  for (const row of read.rows) {
    const on_date = readDate(valueOf(row, cols, 'date'))
    const out = readAmount(valueOf(row, cols, 'debit'), ccy)
    const inn = readAmount(valueOf(row, cols, 'credit'), ccy)
    const single = readAmount(valueOf(row, cols, 'amount'), ccy)
    // Two columns or one: a debit column is money out whichever sign it carries.
    const amount = (inn != null && inn !== 0) ? Math.abs(inn)
      : ((out != null && out !== 0) ? -Math.abs(out) : single)
    const line = {
      on_date,
      description: valueOf(row, cols, 'description') || null,
      ref: valueOf(row, cols, 'number') || null,
      amount,
      currency: ccy,
      balance: readAmount(valueOf(row, cols, 'balance'), ccy),
    }
    const why = !on_date ? 'could not read the date'
      : (amount == null || amount === 0 ? 'could not read the amount' : null)
    const fingerprint = why ? null : fingerprintOf(account?.id || account_code, line)
    plan.push({
      row,
      line,
      action: why ? 'skip' : (known.has(fingerprint) ? 'already here' : 'add'),
      why,
      fingerprint,
    })
  }
  return { ...read, columns: cols, plan, currency: ccy, account }
}

export async function importStatement(db, opts) {
  const { entity_id, account_code = '1010', source_name = null, person_id = null } = opts
  const { plan, account, columns, headers } = await previewStatement(db, opts)
  const batch = await started(db, { entity_id, kind: 'statement', source_name, person_id })
  let added = 0
  let duplicates = 0
  let skipped = 0
  for (const item of plan) {
    if (item.action === 'skip') { skipped++; continue }
    if (item.action === 'already here') { duplicates++; continue }
    await db.run(
      `INSERT INTO bank_line(id, entity_id, account_id, batch_id, on_date, description, ref,
         amount, currency, balance, fingerprint)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), entity_id, account?.id || null, batch, item.line.on_date, item.line.description,
      item.line.ref, item.line.amount, item.line.currency, item.line.balance, item.fingerprint)
    added++
  }
  const counts = { added, duplicates, skipped }
  await finished(db, batch, counts)
  return { batch_id: batch, columns, headers, ...counts }
}

export const statementLines = (db, entityId, { status = 'new', limit = 200 } = {}) => db.all(
  `SELECT * FROM bank_line WHERE entity_id = ? AND (? IS NULL OR status = ?)
    ORDER BY on_date DESC, imported_at DESC LIMIT ?`, entityId, status, status, limit)

/** Which open document a line belongs to, best first. */
export async function suggestFor(db, line) {
  const entityId = line.entity_id
  if (line.amount > 0) {
    const ranked = (await matchIncoming(db, entityId, { amount: line.amount }))
      .map((r) => ({ kind: 'doc', ...r }))
    return withNameMatch(ranked, line)
  }
  const bills = await db.all(
    `SELECT d.*, y.name_en AS party_name_en FROM doc d JOIN party y ON y.id = d.party_id
      WHERE d.entity_id = ? AND d.direction = 'in' AND d.status IN ('issued','part_paid')`,
    entityId)
  const want = Math.abs(line.amount)
  const ranked = []
  for (const d of bills) {
    const owed = d.gross - d.paid - d.wht_credited
    if (owed === want) ranked.push({ kind: 'doc', doc: d, confidence: 85, why: 'exact amount owed' })
    else if (Math.abs(owed - want) <= 100) {
      ranked.push({ kind: 'doc', doc: d, confidence: 25, why: 'within a baht' })
    }
  }
  // Money going out to an office is a payment too: a return that has been filed
  // and not paid is a candidate, so the transfer to the Revenue Department is
  // not a line that can never be placed. It is never settled automatically —
  // paying the government on a guess is not a thing this should do.
  for (const f of await unpaidFilings(db, entityId)) {
    const owed = f.amount ?? 0
    if (owed === want) {
      ranked.push({
        kind: 'filing', filing: f, confidence: 70,
        why: `${f.code} ${f.period}, exactly what was filed`,
      })
    }
  }
  return withNameMatch(ranked.sort((a, b) => b.confidence - a.confidence), line)
}

/** A name in the statement narrative is worth a few points, not a decision. */
function withNameMatch(ranked, line) {
  const text = String(line.description || '').toLowerCase()
  if (!text) return ranked
  return ranked.map((r) => {
    const name = String(r.doc?.party_name_en || r.filing?.name_en || '').toLowerCase()
    const first = name.split(/[\s,.]+/).find((w) => w.length > 3)
    const hit = first && text.includes(first)
    return hit
      ? { ...r, confidence: Math.min(99, r.confidence + 5), why: `${r.why}, and the name is in the line` }
      : r
  }).sort((a, b) => b.confidence - a.confidence)
}

/** Settle one statement line against one document, and mark the line done. */
export async function applyLine(db, lineId, docId, { person_id = null } = {}) {
  const line = await db.get('SELECT * FROM bank_line WHERE id = ?', lineId)
  if (!line) throw new PostingError('no_line', 'No such statement line.')
  if (line.status === 'matched') return line
  const doc = await db.get('SELECT * FROM doc WHERE id = ?', docId)
  const account = line.account_id
    ? (await db.get('SELECT code FROM account WHERE id = ?', line.account_id))?.code
    : '1010'
  const owed = doc.gross - doc.paid - doc.wht_credited
  const cash = Math.min(Math.abs(line.amount), owed)
  // The odd satang of a payment tail is not a debt: the invoice closes exactly.
  const tail = doc.direction === 'out' ? Math.abs(line.amount) - owed : 0
  const payment = await recordPayment(db, {
    entity_id: line.entity_id,
    direction: doc.direction === 'out' ? 'in' : 'out',
    on_date: line.on_date,
    party_id: doc.party_id,
    account,
    method: 'transfer',
    amount: Math.abs(line.amount),
    slip_ref: line.ref || (line.description || '').slice(0, 60),
    idem_key: `bankline:${line.id}`,
    posted_by: person_id,
    allocations: [{ doc_id: docId, amount: tail > 0 ? owed : cash }],
  })
  await db.run(
    "UPDATE bank_line SET status = 'matched', payment_id = ?, doc_id = ? WHERE id = ?",
    payment.id, docId, lineId)
  return db.get('SELECT * FROM bank_line WHERE id = ?', lineId)
}

/** Settle one statement line against a filed return. */
export async function applyLineToFiling(db, lineId, filingId, { person_id = null } = {}) {
  const line = await db.get('SELECT * FROM bank_line WHERE id = ?', lineId)
  if (!line) throw new PostingError('no_line', 'No such statement line.')
  if (line.status === 'matched') return line
  const account = line.account_id
    ? (await db.get('SELECT code FROM account WHERE id = ?', line.account_id))?.code
    : '1010'
  await payFiling(db, filingId, {
    on_date: line.on_date,
    account,
    amount: Math.abs(line.amount),
    ref: line.ref || (line.description || '').slice(0, 60),
    person_id,
  })
  await db.run(
    "UPDATE bank_line SET status = 'matched', filing_id = ? WHERE id = ?", filingId, lineId)
  return db.get('SELECT * FROM bank_line WHERE id = ?', lineId)
}

export const ignoreLine = (db, lineId) =>
  db.run("UPDATE bank_line SET status = 'ignored' WHERE id = ?", lineId)

/**
 * Everything the statement can settle on its own: an exact amount carrying its
 * own satang tail, with nothing else it could be. The rest stays on the screen
 * for a person, which is the only honest place for it.
 */
export async function settleWhatIsClear(db, entityId, { person_id = null, floor = 90 } = {}) {
  const lines = await statementLines(db, entityId, { status: 'new' })
  const done = []
  const left = []
  for (const line of lines) {
    const ranked = await suggestFor(db, line)
    const top = ranked[0]
    const clear = ranked.length && top.confidence >= floor && top.kind !== 'filing'
      && !(ranked.length > 1 && ranked[1].confidence === top.confidence)
    if (!clear) { left.push({ line, ranked }); continue }
    await applyLine(db, line.id, ranked[0].doc.id, { person_id })
    done.push({ line, doc: ranked[0].doc, why: ranked[0].why })
  }
  return { settled: done, waiting: left }
}

export const batches = (db, entityId, { limit = 20 } = {}) => db.all(
  'SELECT * FROM import_batch WHERE entity_id = ? ORDER BY at DESC LIMIT ?', entityId, limit)
