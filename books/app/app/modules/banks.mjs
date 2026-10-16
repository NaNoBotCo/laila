// banks.mjs — more than one bank, in more than one currency.
//
// An operator with a Thai account, a Cambodian account and a dollar account has
// three questions this answers:
//
//   what is in each one            balances per account, in the account's own
//                                  currency, never silently added together
//   what is it altogether          one total, at a stated rate, with the rate
//                                  and its date shown beside it
//   moving money between them      a transfer that posts both sides and puts
//                                  the difference where it belongs
//
// An account IS the bank account: the chart row carries the bank's name, the
// number and the currency, so a balance can be read against a statement without
// a second table to keep in step.

import { uid } from '../lib/ids.mjs'
import { post, accountByCode, PostingError } from './books.mjs'
import { rateOn, convertMoney, invert, PPM } from '../lib/fx.mjs'

/** Open an account in the chart that stands for one real account somewhere. */
export async function addBankAccount(db, {
  entity_id, code = null, name_en, name_th = null, name_km = null, bank_name = null,
  account_no = null, currency = null, opened_on = null, note = null,
  swift = null, iban = null, bank_address = null,
}) {
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entity_id)
  const use = code || await nextCashCode(db, entity_id)
  const seen = await accountByCode(db, entity_id, use)
  if (seen) return seen
  await db.run(
    `INSERT INTO account(id, entity_id, code, name_en, name_th, name_km, type,
       subtype, currency, bank_name, account_no, is_bank, opened_on, note,
       swift, iban, bank_address)
     VALUES (?,?,?,?,?,?,'asset','cash',?,?,?,1,?,?,?,?,?)`,
    uid(), entity_id, use, name_en, name_th, name_km,
    currency || entity?.currency || 'THB', bank_name, account_no, opened_on, note,
    swift, iban, bank_address)
  return accountByCode(db, entity_id, use)
}

async function nextCashCode(db, entityId) {
  const rows = await db.all(
    "SELECT code FROM account WHERE entity_id = ? AND code LIKE '10%'", entityId)
  const used = new Set(rows.map((r) => r.code))
  for (let n = 1010; n < 1100; n++) {
    if (!used.has(String(n))) return String(n)
  }
  throw new PostingError('no_code', 'No free account code for another bank account.')
}

/**
 * What is in each account, in its own currency — and what that comes to in the
 * books' currency at the rate on a date. Where no rate is recorded, the row
 * says so instead of being counted at parity.
 */
export async function balances(db, entityId, { asOf = null, to = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10)
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entityId)
  const into = to || entity?.currency || 'THB'
  const accounts = await db.all(
    `SELECT * FROM account WHERE entity_id = ? AND subtype IN ('cash','crypto')
       AND is_active = 1 ORDER BY is_bank DESC, code`, entityId)

  const rows = []
  for (const a of accounts) {
    const row = await db.get(
      `SELECT COALESCE(SUM(l.amount),0) AS booked,
              COALESCE(SUM(l.fx_amount),0) AS own
         FROM journal_line l JOIN journal j ON j.id = l.journal_id
        WHERE j.entity_id = ? AND l.account_id = ? AND j.on_date <= ?`,
      entityId, a.id, date)
    const ccy = a.currency || into
    const coin = a.subtype === 'crypto'
    // A foreign account's own balance is the sum of its foreign amounts; where
    // none were recorded the booked figure IS its own currency.
    const own = ccy === into ? row.booked : row.own
    // A COIN IS NOT A CURRENCY. Its units are not minor units of money and its
    // price is not an exchange rate, so here it counts at what it cost and its
    // market value is the digital assets panel's business.
    const rate = coin || ccy === into
      ? { rate_ppm: PPM, via: coin ? 'cost' : 'same' }
      : await rateOn(db, ccy, into, date)
    rows.push({
      account: a,
      currency: ccy,
      own,
      booked: row.booked,
      rate: rate?.rate_ppm ?? null,
      rate_via: rate?.via ?? null,
      rate_on: rate?.on_date ?? null,
      value: rate ? (coin || ccy === into ? row.booked : convertMoney(own, rate.rate_ppm, ccy, into)) : null,
      is_bank: a.is_bank === 1,
      kind: a.subtype,
      coin,
    })
  }
  // Money is totalled per currency; coin is counted in its own units and kept
  // out of the money totals.
  const byCurrency = {}
  const byCoin = {}
  for (const r of rows) {
    if (r.coin) byCoin[r.currency] = (byCoin[r.currency] || 0) + r.own
    else byCurrency[r.currency] = (byCurrency[r.currency] || 0) + r.own
  }
  return {
    into,
    rows,
    byCurrency,
    byCoin,
    money: rows.filter((r) => !r.coin).reduce((a, r) => a + (r.value ?? 0), 0),
    total: rows.reduce((a, r) => a + (r.value ?? 0), 0),
    unpriced: rows.filter((r) => r.value == null).length,
  }
}

/**
 * Money from one account to another, including across a currency.
 *
 * Both sides are posted at their own rate and the difference is an exchange
 * difference — which is what a transfer between a baht account and a dollar
 * account actually produces, rather than a number that fails to balance.
 */
export async function transfer(db, {
  entity_id, from_code, to_code, amount, on_date, to_amount = null, fee = 0,
  rate_ppm = null, note = null, posted_by = null, idem_key = null,
}) {
  const from = await accountByCode(db, entity_id, from_code)
  const to = await accountByCode(db, entity_id, to_code)
  if (!from || !to) throw new PostingError('no_account', 'Both accounts must exist.')
  if (from.id === to.id) throw new PostingError('same_account', 'That is the same account.')

  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entity_id)
  const books = entity?.currency || 'THB'
  const fromCcy = from.currency || books
  const toCcy = to.currency || books

  const rateFor = async (ccy) => {
    if (ccy === books) return PPM
    const found = await rateOn(db, ccy, books, on_date, { through: books })
    if (!found) throw new PostingError('no_fx_rate', `No rate for ${ccy} to ${books}.`)
    return found.rate_ppm
  }
  const fromRate = await rateFor(fromCcy)
  const toRate = await rateFor(toCcy)

  // What lands the other end: given, or worked out from the two rates.
  const landed = to_amount ?? (fromCcy === toCcy
    ? amount - fee
    : convertMoney(convertMoney(amount - fee, fromRate, fromCcy, books), invert(toRate), books, toCcy))

  const outBooks = convertMoney(amount, fromRate, fromCcy, books)
  const inBooks = convertMoney(landed, toRate, toCcy, books)
  const feeBooks = fee ? convertMoney(fee, fromRate, fromCcy, books) : 0
  const feeAcct = await accountByCode(db, entity_id, '6500')
  const fxAcct = await accountByCode(db, entity_id, '7000')

  const lines = [
    {
      account: to.id,
      amount: inBooks,
      ...(toCcy === books ? { currency: books } : { currency: toCcy, fx_amount: landed, fx_rate_ppm: toRate }),
      memo: note,
    },
    {
      account: from.id,
      amount: -outBooks,
      ...(fromCcy === books ? { currency: books } : { currency: fromCcy, fx_amount: -amount, fx_rate_ppm: fromRate }),
      memo: note,
    },
  ]
  if (feeBooks && feeAcct) lines.push({ account: feeAcct.id, amount: feeBooks, memo: 'bank charge' })
  const gap = lines.reduce((a, l) => a + l.amount, 0)
  if (gap && fxAcct) lines.push({ account: fxAcct.id, amount: -gap, memo: 'exchange difference' })

  return post(db, {
    entity_id,
    on_date,
    memo_en: `Transfer ${from.code} → ${to.code}`,
    source_kind: 'transfer',
    source_id: `${from.code}:${to.code}`,
    idem_key,
    posted_by,
    lines,
  })
}

/** Bank accounts only, for a screen that asks "where is the money". */
export const bankAccounts = (db, entityId) => db.all(
  `SELECT * FROM account WHERE entity_id = ? AND is_bank = 1 AND is_active = 1
    ORDER BY code`, entityId)
