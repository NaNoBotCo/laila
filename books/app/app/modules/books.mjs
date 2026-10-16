// books.mjs — posting to the ledger, and reading balances back out.
//
// One way in: `post()`. Everything else in this system — an invoice, a
// payment, a payslip, a stock sale — builds a list of lines and hands it here,
// so there is a single place where balance, period and account existence are
// checked, and a single shape in the journal whatever produced it.
//
// Signed amounts: positive is a debit, negative a credit. A journal balances
// when its lines sum to zero.

import { uid, nextNumber } from '../lib/ids.mjs'

export class PostingError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** Account row by code within an entity's books. */
export async function accountByCode(db, entityId, code) {
  return db.get('SELECT * FROM account WHERE entity_id = ? AND code = ?', entityId, code)
}

/** The first active account with a given subtype — 'cash', 'ar', 'vat_out'. */
export async function accountBySubtype(db, entityId, subtype) {
  return db.get(
    `SELECT * FROM account WHERE entity_id = ? AND subtype = ? AND is_active = 1
      ORDER BY code LIMIT 1`, entityId, subtype)
}

async function resolveAccount(db, entityId, ref) {
  if (!ref) throw new PostingError('no_account', 'A line has no account.')
  if (typeof ref === 'object') return ref
  const byCode = await accountByCode(db, entityId, String(ref))
  if (byCode) return byCode
  const byId = await db.get('SELECT * FROM account WHERE id = ? AND entity_id = ?', ref, entityId)
  if (byId) return byId
  throw new PostingError('no_account', `No account ${ref} in these books.`, { code: ref })
}

/** Period rows are created on first use and start open. */
export async function ensurePeriod(db, entityId, ym) {
  const row = await db.get('SELECT * FROM period WHERE entity_id = ? AND ym = ?', entityId, ym)
  if (row) return row
  const id = uid()
  await db.run('INSERT INTO period(id, entity_id, ym, status) VALUES (?,?,?,?)',
    id, entityId, ym, 'open')
  return { id, entity_id: entityId, ym, status: 'open' }
}

export async function closePeriod(db, entityId, ym, personId) {
  await ensurePeriod(db, entityId, ym)
  await db.run(
    `UPDATE period SET status = 'closed', closed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       closed_by = ? WHERE entity_id = ? AND ym = ?`, personId ?? null, entityId, ym)
}

export async function reopenPeriod(db, entityId, ym) {
  await db.run(
    `UPDATE period SET status = 'open', closed_at = NULL, closed_by = NULL
      WHERE entity_id = ? AND ym = ?`, entityId, ym)
}

/**
 * Post a journal.
 *
 * @param lines  [{ account, amount, project_id, party_id, person_id,
 *                  cost_centre, tax_code, memo, currency, fx_amount, fx_rate_ppm }]
 *               `account` is a code ('1000'), an id, or a row.
 * @returns the journal row, with `.lines`.
 *
 * Idempotency: a journal carrying an `idem_key` that has already been posted
 * returns the existing journal untouched. A billing run that died half way and
 * is run again then finishes rather than doubling.
 */
export async function post(db, {
  entity_id, on_date, memo_en = null, memo_th = null,
  source_kind = 'manual', source_id = null, idem_key = null,
  posted_by = null, lines = [],
}) {
  if (!entity_id) throw new PostingError('no_entity', 'A journal needs an entity.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on_date || ''))) {
    throw new PostingError('bad_date', `Not a date: ${on_date}`)
  }
  if (idem_key) {
    const seen = await db.get('SELECT * FROM journal WHERE idem_key = ?', idem_key)
    if (seen) return { ...seen, lines: await linesOf(db, seen.id), reused: true }
  }
  if (!lines.length) throw new PostingError('empty', 'A journal with no lines posts nothing.')

  const resolved = []
  for (const l of lines) {
    const amount = Math.trunc(Number(l.amount) || 0)
    if (!Number.isSafeInteger(amount)) {
      throw new PostingError('bad_amount', `Not an integer amount: ${l.amount}`)
    }
    if (amount === 0) continue          // a zero line carries no information
    const acct = await resolveAccount(db, entity_id, l.account)
    resolved.push({ ...l, amount, account: acct })
  }
  if (!resolved.length) throw new PostingError('empty', 'Every line was zero.')

  // Balance is checked per currency: a journal mixing THB and USD lines must
  // balance in the booked currency, and the foreign amounts ride along.
  const sum = resolved.reduce((a, l) => a + l.amount, 0)
  if (sum !== 0) {
    throw new PostingError('unbalanced', `Entries do not balance by ${sum}.`, { diff: sum })
  }

  const ym = String(on_date).slice(0, 7)
  const period = await ensurePeriod(db, entity_id, ym)
  if (period.status === 'closed') {
    throw new PostingError('period_closed', `${ym} is closed.`, { ym })
  }

  const id = uid()
  const ref = await nextNumber(db, entity_id, 'journal', Number(String(on_date).slice(0, 4)))
  await db.run(
    `INSERT INTO journal(id, entity_id, ref, on_date, ym, memo_en, memo_th,
       source_kind, source_id, idem_key, posted_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, ref, on_date, ym, memo_en, memo_th, source_kind, source_id,
    idem_key, posted_by)

  let seq = 0
  for (const l of resolved) {
    await db.run(
      `INSERT INTO journal_line(id, journal_id, seq, account_id, amount, currency,
         fx_amount, fx_rate_ppm, project_id, party_id, person_id, cost_centre, tax_code, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), id, seq++, l.account.id, l.amount, l.currency || 'THB',
      l.fx_amount ?? null, l.fx_rate_ppm ?? null,
      l.project_id ?? null, l.party_id ?? null, l.person_id ?? null,
      l.cost_centre || 'company', l.tax_code ?? null, l.memo ?? null)
  }

  const row = await db.get('SELECT * FROM journal WHERE id = ?', id)
  return { ...row, lines: await linesOf(db, id) }
}

export async function linesOf(db, journalId) {
  return db.all(
    `SELECT l.*, a.code AS account_code, a.name_en AS account_name_en,
            a.name_th AS account_name_th,
            a.name_km AS account_name_km, a.type AS account_type, a.subtype
       FROM journal_line l JOIN account a ON a.id = l.account_id
      WHERE l.journal_id = ? ORDER BY l.seq`, journalId)
}

/**
 * Reverse a journal. The original stays exactly as it was posted and a new
 * journal cancels it, so the error and its correction are both readable a year
 * later — which is what an auditor asks for and what a deleted row cannot give.
 */
export async function reverse(db, journalId, { on_date, posted_by = null, memo_en, memo_th } = {}) {
  const j = await db.get('SELECT * FROM journal WHERE id = ?', journalId)
  if (!j) throw new PostingError('not_found', 'No such journal.')
  const already = await db.get('SELECT id FROM journal WHERE reverses_id = ?', journalId)
  if (already) return db.get('SELECT * FROM journal WHERE id = ?', already.id)
  const lines = await linesOf(db, journalId)
  const out = await post(db, {
    entity_id: j.entity_id,
    on_date: on_date || j.on_date,
    memo_en: memo_en ?? `Reversal of ${j.ref}`,
    memo_th: memo_th ?? `กลับรายการ ${j.ref}`,
    source_kind: 'reversal',
    source_id: j.id,
    posted_by,
    lines: lines.map((l) => ({
      account: l.account_id,
      amount: -l.amount,
      currency: l.currency,
      fx_amount: l.fx_amount == null ? null : -l.fx_amount,
      fx_rate_ppm: l.fx_rate_ppm,
      project_id: l.project_id,
      party_id: l.party_id,
      person_id: l.person_id,
      cost_centre: l.cost_centre,
      tax_code: l.tax_code,
      memo: l.memo,
    })),
  })
  await db.run('UPDATE journal SET reverses_id = ? WHERE id = ?', journalId, out.id)
  return { ...out, reverses_id: journalId }
}

// ---- reading ---------------------------------------------------------------

/** Balance of one account, optionally as at a date. */
export async function balanceOf(db, accountId, { from, to } = {}) {
  const where = ['l.account_id = ?']
  const args = [accountId]
  if (from) { where.push('j.on_date >= ?'); args.push(from) }
  if (to) { where.push('j.on_date <= ?'); args.push(to) }
  const row = await db.get(
    `SELECT COALESCE(SUM(l.amount),0) AS balance FROM journal_line l
       JOIN journal j ON j.id = l.journal_id WHERE ${where.join(' AND ')}`, ...args)
  return row?.balance ?? 0
}

/**
 * Trial balance. Returns one row per account with a movement or a balance,
 * with debits positive and credits shown as their own column so the two
 * totals can be read against each other.
 */
export async function trialBalance(db, entityId, { from, to, project_id, cost_centre } = {}) {
  const where = ['j.entity_id = ?']
  const args = [entityId]
  if (from) { where.push('j.on_date >= ?'); args.push(from) }
  if (to) { where.push('j.on_date <= ?'); args.push(to) }
  if (project_id) { where.push('l.project_id = ?'); args.push(project_id) }
  if (cost_centre) { where.push('l.cost_centre = ?'); args.push(cost_centre) }
  const rows = await db.all(
    `SELECT a.id, a.code, a.name_en, a.name_th, a.type, a.subtype,
            SUM(l.amount) AS balance,
            SUM(CASE WHEN l.amount > 0 THEN l.amount ELSE 0 END) AS debits,
            SUM(CASE WHEN l.amount < 0 THEN -l.amount ELSE 0 END) AS credits
       FROM journal_line l
       JOIN journal j ON j.id = l.journal_id
       JOIN account a ON a.id = l.account_id
      WHERE ${where.join(' AND ')}
      GROUP BY a.id HAVING balance <> 0 OR debits <> 0
      ORDER BY a.code`, ...args)
  const totals = rows.reduce((t, r) => ({
    debits: t.debits + r.debits, credits: t.credits + r.credits,
  }), { debits: 0, credits: 0 })
  return { rows, totals, balanced: totals.debits === totals.credits }
}

/** Income and expense for a span, by account and by project. */
export async function profitAndLoss(db, entityId, { from, to, project_id, cost_centre } = {}) {
  const tb = await trialBalance(db, entityId, { from, to, project_id, cost_centre })
  const income = tb.rows.filter((r) => r.type === 'income')
  const expense = tb.rows.filter((r) => r.type === 'expense')
  // Income accounts carry credit balances (negative), so the sign flips to read.
  const incomeTotal = -income.reduce((a, r) => a + r.balance, 0)
  const expenseTotal = expense.reduce((a, r) => a + r.balance, 0)
  return { income, expense, incomeTotal, expenseTotal, result: incomeTotal - expenseTotal }
}

export async function balanceSheet(db, entityId, { to } = {}) {
  const tb = await trialBalance(db, entityId, { to })
  const pick = (t) => tb.rows.filter((r) => r.type === t)
  const sum = (rows) => rows.reduce((a, r) => a + r.balance, 0)
  const assets = pick('asset')
  const liabilities = pick('liability')
  const equity = pick('equity')
  const pl = await profitAndLoss(db, entityId, { to })
  return {
    assets, liabilities, equity,
    assetsTotal: sum(assets),
    liabilitiesTotal: -sum(liabilities),
    equityTotal: -sum(equity),
    result: pl.result,
  }
}

/** Income and expense per project for a span — which of them pays for itself. */
export async function byProject(db, entityId, { from, to } = {}) {
  const where = ['j.entity_id = ?', "a.type IN ('income','expense')"]
  const args = [entityId]
  if (from) { where.push('j.on_date >= ?'); args.push(from) }
  if (to) { where.push('j.on_date <= ?'); args.push(to) }
  const rows = await db.all(
    `SELECT COALESCE(p.code,'(none)') AS project_code,
            COALESCE(p.name_en,'Unassigned') AS project_name_en,
            p.name_th AS project_name_th,
            p.name_km AS project_name_km,
            SUM(CASE WHEN a.type = 'income' THEN -l.amount ELSE 0 END) AS income,
            SUM(CASE WHEN a.type = 'expense' THEN l.amount ELSE 0 END) AS expense
       FROM journal_line l
       JOIN journal j ON j.id = l.journal_id
       JOIN account a ON a.id = l.account_id
       LEFT JOIN project p ON p.id = l.project_id
      WHERE ${where.join(' AND ')}
      GROUP BY l.project_id ORDER BY income DESC, expense DESC`, ...args)
  return rows.map((r) => ({ ...r, result: r.income - r.expense }))
}
