// crypto.mjs — digital assets in the same books as everything else.
//
// The rules, decided once and applied everywhere:
//
//   A COIN IS NOT CASH. Each wallet is its own asset account, held at what it
//   cost in the entity's own currency. It is never counted in the cash figure.
//
//   A RECEIPT IS BOOKED AT THE DAY'S RATE. The invoice was in baht; the coin
//   arrived at a rate; the difference between what was owed and what the coin
//   was worth is a foreign exchange difference on the day it lands, not a
//   silent adjustment to revenue.
//
//   WHAT IT IS WORTH TODAY IS NOT INCOME. The gap between cost and market is
//   shown as a memo and posted only when something is sold or spent, where it
//   becomes a realised gain or loss with a date and a document.
//
//   AN AMOUNT IS AN INTEGER in the asset's minor unit, and an asset with more
//   decimals than a JavaScript integer can hold exactly is stored to nine and
//   says so.
//
// The tax treatment of a gain is not decided here. It is a question for
// whoever signs the return, and the place to record their answer is a rate row.

import { uid } from '../lib/ids.mjs'
import { post, accountByCode, accountBySubtype, PostingError } from './books.mjs'
import { getDoc, recordPayment } from './documents.mjs'

/** The assets this system knows how to count. `minor` is the exponent it
 *  stores; `chain_minor` is what the chain itself uses, when they differ. */
export const ASSETS = {
  BTC: { minor: 8, chain_minor: 8, label: 'Bitcoin', symbol: '₿' },
  USDT: { minor: 6, chain_minor: 6, label: 'Tether', symbol: '₮' },
  USDC: { minor: 6, chain_minor: 6, label: 'USD Coin', symbol: '$' },
  ETH: { minor: 9, chain_minor: 18, label: 'Ether', symbol: 'Ξ' },
}

export const assetFactor = (asset) => 10 ** (ASSETS[asset]?.minor ?? 8)

/** '0.005' BTC → 500000 satoshi. Null when it cannot be read exactly. */
export function parseAsset(input, asset) {
  const def = ASSETS[asset]
  if (!def) return null
  const s = String(input ?? '').trim().replace(/[,\s₿₮$Ξ]/g, '')
  const re = new RegExp(`^\\d+(\\.\\d{1,${def.minor}})?$`)
  if (!re.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const v = Number(whole) * 10 ** def.minor + Number(frac.padEnd(def.minor, '0'))
  return Number.isSafeInteger(v) ? v : null
}

/** 500000 satoshi → '0.005 BTC', trailing zeros trimmed. */
export function formatAsset(amount, asset, { withSymbol = true } = {}) {
  const def = ASSETS[asset] || ASSETS.BTC
  const f = 10 ** def.minor
  const whole = Math.floor(Math.abs(amount) / f)
  const frac = String(Math.abs(amount) % f).padStart(def.minor, '0').replace(/0+$/, '')
  const body = `${amount < 0 ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`
  return withSymbol ? `${body} ${asset}` : body
}

// ---- wallets ----------------------------------------------------------------

/** A wallet, and the account in the chart that holds what is in it. */
export async function addWallet(db, {
  entity_id, label, asset, network = null, address = null, account_code = null,
  direction = 'in', is_default = false, note = null,
}) {
  if (!ASSETS[asset]) throw new PostingError('unknown_asset', `Nothing here counts ${asset}.`)
  const seen = await db.get(
    'SELECT * FROM wallet WHERE entity_id = ? AND label = ?', entity_id, label)
  if (seen) return seen

  // Wallets live in their own range of the chart, one account each, so the
  // balance sheet shows what is held in what.
  const code = account_code || await nextWalletCode(db, entity_id)
  const exists = await accountByCode(db, entity_id, code)
  if (!exists) {
    await db.run(
      `INSERT INTO account(id, entity_id, code, name_en, name_th, type, subtype, currency)
       VALUES (?,?,?,?,?,'asset','crypto',?)`,
      uid(), entity_id, code, `${asset} — ${label}`, `${asset} — ${label}`, asset)
  }
  const id = uid()
  await db.run(
    `INSERT INTO wallet(id, entity_id, label, asset, network, address, account_code,
       direction, is_default, note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, label, asset, network, address, code, direction,
    is_default ? 1 : 0, note)
  if (is_default) await setDefaultWallet(db, id)
  return db.get('SELECT * FROM wallet WHERE id = ?', id)
}

async function nextWalletCode(db, entityId) {
  const rows = await db.all(
    "SELECT code FROM account WHERE entity_id = ? AND code LIKE '16%' ORDER BY code", entityId)
  const used = new Set(rows.map((r) => r.code))
  for (let n = 1600; n < 1700; n++) {
    if (!used.has(String(n))) return String(n)
  }
  throw new PostingError('no_code', 'No free account code for another wallet.')
}

export const wallets = (db, entityId, { direction = null } = {}) => db.all(
  `SELECT * FROM wallet WHERE entity_id = ? AND is_active = 1
     AND (? IS NULL OR direction = ? OR direction = 'both')
   ORDER BY is_default DESC, asset, label`, entityId, direction, direction)

export async function setDefaultWallet(db, walletId) {
  const w = await db.get('SELECT * FROM wallet WHERE id = ?', walletId)
  await db.run('UPDATE wallet SET is_default = 0 WHERE entity_id = ?', w.entity_id)
  await db.run('UPDATE wallet SET is_default = 1 WHERE id = ?', walletId)
  return db.get('SELECT * FROM wallet WHERE id = ?', walletId)
}

// ---- what it was worth ------------------------------------------------------

export async function setAssetRate(db, { asset, quote = 'THB', rate_ppm, on_date, source = null }) {
  const seen = await db.get(
    'SELECT * FROM asset_rate WHERE asset = ? AND quote = ? AND on_date = ?',
    asset, quote, on_date)
  if (seen) {
    await db.run('UPDATE asset_rate SET rate_ppm = ?, source = ? WHERE id = ?',
      rate_ppm, source ?? seen.source, seen.id)
    return db.get('SELECT * FROM asset_rate WHERE id = ?', seen.id)
  }
  const id = uid()
  await db.run(
    'INSERT INTO asset_rate(id, asset, quote, rate_ppm, on_date, source) VALUES (?,?,?,?,?,?)',
    id, asset, quote, rate_ppm, on_date, source)
  return db.get('SELECT * FROM asset_rate WHERE id = ?', id)
}

/** The latest rate recorded ON or BEFORE a date. A rate from last week is a
 *  stale rate and the row says so; there is no invented number. */
export const assetRateOn = (db, asset, onDate, { quote = 'THB' } = {}) => db.get(
  `SELECT * FROM asset_rate WHERE asset = ? AND quote = ? AND on_date <= ?
    ORDER BY on_date DESC LIMIT 1`, asset, quote, onDate)

/** Whole units of `quote` for an amount in the asset's minor unit. */
export function convertAsset(amount, asset, ratePpm, { quoteMinor = 2 } = {}) {
  const units = amount / assetFactor(asset)
  return Math.round(units * (ratePpm / 1_000_000) * 10 ** quoteMinor)
}

/** The other way: what to ask for in coin, for an amount of money. */
export function assetForMoney(money, asset, ratePpm, { quoteMinor = 2 } = {}) {
  if (!ratePpm) return null
  const units = (money / 10 ** quoteMinor) / (ratePpm / 1_000_000)
  return Math.round(units * assetFactor(asset))
}

// ---- being paid in it -------------------------------------------------------

/**
 * A payment link for a wallet. Bitcoin has a URI scheme that carries the
 * amount; the rest are read as an address and an amount beside it, which is
 * what wallet apps actually scan.
 */
export function walletUri(wallet, { amount = null } = {}) {
  if (!wallet?.address) return null
  if (wallet.asset === 'BTC') {
    const units = amount ? (amount / assetFactor('BTC')).toFixed(8).replace(/0+$/, '') : null
    return `bitcoin:${wallet.address}${units ? `?amount=${units}` : ''}`
  }
  if (wallet.network === 'ethereum' && wallet.asset === 'ETH') {
    return `ethereum:${wallet.address}`
  }
  return wallet.address
}

/**
 * Money arrived as coin against an invoice.
 *
 * Three figures and they are all kept: what the invoice asked for, what the
 * coin was worth at the day's rate, and the difference. The wallet is debited
 * at the value on the day — that is its cost — and the difference is an
 * exchange difference, because the customer's debt was in baht.
 */
export async function receiveCrypto(db, {
  entity_id, doc_id = null, party_id = null, wallet_id, asset_amount, on_date,
  rate_ppm = null, tx_ref = null, note = null, posted_by = null, idem_key = null,
}) {
  const wallet = await db.get('SELECT * FROM wallet WHERE id = ?', wallet_id)
  if (!wallet) throw new PostingError('no_wallet', 'No such wallet.')
  const rate = rate_ppm ?? (await assetRateOn(db, wallet.asset, on_date))?.rate_ppm
  if (!rate) {
    throw new PostingError('no_rate',
      `No rate recorded for ${wallet.asset} on or before ${on_date}.`)
  }
  const value = convertAsset(asset_amount, wallet.asset, rate)

  const doc = doc_id ? await getDoc(db, doc_id) : null
  const owed = doc ? doc.gross - doc.paid - doc.wht_credited : value
  const settled = Math.min(owed, value)
  const difference = value - settled

  const walletAccount = await accountByCode(db, entity_id, wallet.account_code)
  const control = await accountBySubtype(db, entity_id, 'ar')
  const fx = await accountByCode(db, entity_id, '7000')

  const lines = [{
    account: walletAccount.id,
    amount: value,
    party_id,
    currency: wallet.asset,
    fx_amount: asset_amount,
    fx_rate_ppm: rate,
    memo: tx_ref,
  }]
  if (doc) {
    lines.push({ account: control.id, amount: -settled, party_id: doc.party_id })
    if (difference) {
      // More coin than the invoice asked for, or less: the gap belongs in
      // exchange difference rather than in what was sold.
      lines.push({ account: fx.id, amount: -difference, memo: 'exchange difference' })
    }
  } else {
    lines.push({ account: fx.id, amount: -value, memo: note || 'received' })
  }

  const journal = await post(db, {
    entity_id,
    on_date,
    memo_en: `Received ${formatAsset(asset_amount, wallet.asset)}`,
    source_kind: 'crypto',
    source_id: doc_id || wallet.id,
    idem_key: idem_key || (tx_ref ? `crypto:in:${tx_ref}` : null),
    posted_by,
    lines,
  })

  // The journal was already there: this transaction has been recorded once,
  // and recording the payment again would only fail on its own key.
  if (journal.reused) {
    const already = await db.get(
      'SELECT * FROM payment WHERE journal_id = ?', journal.id)
    return { payment: already, journal, value, rate, difference }
  }

  const paymentId = uid()
  await db.run(
    `INSERT INTO payment(id, entity_id, direction, on_date, party_id, account_id,
       method, currency, amount, wht_amount, slip_ref, note, journal_id, idem_key,
       asset, network, asset_amount, asset_rate_ppm, tx_ref)
     VALUES (?,?,'in',?,?,?,'other',?,?,0,?,?,?,?,?,?,?,?,?)`,
    paymentId, entity_id, on_date, party_id || doc?.party_id || null, walletAccount.id,
    wallet.asset, value, tx_ref, note, journal.id,
    idem_key || (tx_ref ? `crypto:pay:${tx_ref}` : null),
    wallet.asset, wallet.network, asset_amount, rate, tx_ref)

  if (doc) {
    await db.run(
      'INSERT INTO allocation(id, payment_id, doc_id, amount, wht_amount) VALUES (?,?,?,?,0)',
      uid(), paymentId, doc.id, settled)
    await db.run(
      `UPDATE doc SET paid = paid + ?,
         status = CASE WHEN paid + ? + wht_credited >= gross THEN 'paid' ELSE 'part_paid' END
       WHERE id = ?`, settled, settled, doc.id)
  }
  return {
    payment: await db.get('SELECT * FROM payment WHERE id = ?', paymentId),
    journal,
    value,
    rate,
    difference,
  }
}

/**
 * Coin spent: paying a supplier, or selling it.
 *
 * What leaves the wallet leaves at its AVERAGE COST, and the difference
 * between that and what it was worth on the day is realised then and there —
 * which is the moment a gain becomes a number anyone can be asked about.
 */
export async function spendCrypto(db, {
  entity_id, wallet_id, asset_amount, on_date, rate_ppm = null, doc_id = null,
  party_id = null, expense_code = null, tx_ref = null, note = null, posted_by = null,
}) {
  const wallet = await db.get('SELECT * FROM wallet WHERE id = ?', wallet_id)
  if (!wallet) throw new PostingError('no_wallet', 'No such wallet.')
  const rate = rate_ppm ?? (await assetRateOn(db, wallet.asset, on_date))?.rate_ppm
  if (!rate) throw new PostingError('no_rate', `No rate for ${wallet.asset} on ${on_date}.`)

  const held = await holdingOf(db, entity_id, wallet)
  if (asset_amount > held.units) {
    throw new PostingError('short',
      `The wallet holds ${formatAsset(held.units, wallet.asset)}.`)
  }
  const carrying = held.units
    ? Math.round((held.cost * asset_amount) / held.units)
    : 0
  const marketValue = convertAsset(asset_amount, wallet.asset, rate)
  const realised = marketValue - carrying

  const walletAccount = await accountByCode(db, entity_id, wallet.account_code)
  const gains = await accountByCode(db, entity_id, '4910')
  const control = doc_id ? await accountBySubtype(db, entity_id, 'ap') : null
  const expense = expense_code ? await accountByCode(db, entity_id, expense_code) : null

  const lines = [
    // What it is used for, at what it is worth today.
    {
      account: (control || expense || gains).id,
      amount: marketValue,
      party_id,
      memo: note,
    },
    // Out of the wallet at what it cost.
    {
      account: walletAccount.id,
      amount: -carrying,
      currency: wallet.asset,
      fx_amount: -asset_amount,
      fx_rate_ppm: rate,
      memo: tx_ref,
    },
  ]
  if (realised) {
    lines.push({
      account: gains.id,
      amount: -realised,
      memo: realised > 0 ? 'gain on disposal' : 'loss on disposal',
    })
  }

  const journal = await post(db, {
    entity_id,
    on_date,
    memo_en: `Paid ${formatAsset(asset_amount, wallet.asset)}`,
    source_kind: 'crypto',
    source_id: doc_id || wallet.id,
    idem_key: tx_ref ? `crypto:out:${tx_ref}` : null,
    posted_by,
    lines,
  })

  if (doc_id) {
    await recordPaymentRow(db, {
      entity_id, wallet, walletAccount, on_date, party_id, value: marketValue,
      asset_amount, rate, tx_ref, note, journal_id: journal.id, doc_id,
    })
  }
  return { journal, carrying, marketValue, realised, rate }
}

async function recordPaymentRow(db, {
  entity_id, wallet, walletAccount, on_date, party_id, value, asset_amount, rate,
  tx_ref, note, journal_id, doc_id,
}) {
  const id = uid()
  await db.run(
    `INSERT INTO payment(id, entity_id, direction, on_date, party_id, account_id,
       method, currency, amount, wht_amount, slip_ref, note, journal_id, idem_key,
       asset, network, asset_amount, asset_rate_ppm, tx_ref)
     VALUES (?,?,'out',?,?,?,'other',?,?,0,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, on_date, party_id, walletAccount.id, wallet.asset, value,
    tx_ref, note, journal_id, tx_ref ? `crypto:payout:${tx_ref}` : null,
    wallet.asset, wallet.network, -asset_amount, rate, tx_ref)
  await db.run(
    'INSERT INTO allocation(id, payment_id, doc_id, amount, wht_amount) VALUES (?,?,?,?,0)',
    uid(), id, doc_id, value)
  await db.run(
    `UPDATE doc SET paid = paid + ?,
       status = CASE WHEN paid + ? + wht_credited >= gross THEN 'paid' ELSE 'part_paid' END
     WHERE id = ?`, value, value, doc_id)
}

// ---- what is held -----------------------------------------------------------

/** Units and cost in one wallet, from the ledger rather than from a counter. */
export async function holdingOf(db, entityId, wallet) {
  const account = await accountByCode(db, entityId, wallet.account_code)
  const row = await db.get(
    `SELECT COALESCE(SUM(l.fx_amount),0) AS units, COALESCE(SUM(l.amount),0) AS cost
       FROM journal_line l JOIN journal j ON j.id = l.journal_id
      WHERE j.entity_id = ? AND l.account_id = ?`, entityId, account?.id ?? '')
  return { units: row?.units ?? 0, cost: row?.cost ?? 0 }
}

/**
 * Everything held, at cost and at the last rate recorded — with the gap
 * between them shown and NOT posted. An unrealised difference is a fact about
 * the market, not a transaction.
 */
export async function holdings(db, entityId, { asOf = null } = {}) {
  const date = asOf || new Date().toISOString().slice(0, 10)
  const rows = []
  for (const w of await wallets(db, entityId)) {
    const held = await holdingOf(db, entityId, w)
    const rate = await assetRateOn(db, w.asset, date)
    const value = rate ? convertAsset(held.units, w.asset, rate.rate_ppm) : null
    rows.push({
      wallet: w,
      asset: w.asset,
      units: held.units,
      cost: held.cost,
      rate: rate?.rate_ppm ?? null,
      rate_on: rate?.on_date ?? null,
      rate_source: rate?.source ?? null,
      value,
      difference: value == null ? null : value - held.cost,
      stale: rate ? rate.on_date < date : true,
    })
  }
  return {
    rows,
    cost: rows.reduce((a, r) => a + r.cost, 0),
    value: rows.reduce((a, r) => a + (r.value ?? r.cost), 0),
  }
}

/** The account a realised gain or loss lands in, created on first use. */
export async function ensureCryptoAccounts(db, entityId) {
  for (const [code, en, th, type, subtype] of [
    ['4910', 'Gain on digital assets', 'กำไรจากสินทรัพย์ดิจิทัล', 'income', null],
    ['7000', 'Exchange difference', 'ผลต่างอัตราแลกเปลี่ยน', 'expense', null],
  ]) {
    const seen = await accountByCode(db, entityId, code)
    if (seen) continue
    await db.run(
      `INSERT INTO account(id, entity_id, code, name_en, name_th, type, subtype)
       VALUES (?,?,?,?,?,?,?)`, uid(), entityId, code, en, th, type, subtype)
  }
}
