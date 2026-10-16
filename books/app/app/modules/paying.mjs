// paying.mjs — making the payment the easy part.
//
// The work here is removing steps from the payer's side, in this order:
//
//   nothing to type   a PromptPay QR carries the payee and the exact amount
//   nothing to quote  the amount itself identifies the invoice (satang tail)
//   nothing to log in a link opens the page, scan, done
//   nothing to chase  the slip's own QR gives the bank reference back
//
// And one rule that does not bend: A CLAIM IS NOT A PAYMENT. Someone saying
// they paid, even with a photograph, records a claim. The invoice closes when
// the money is recorded — by the bookkeeper, from the bank.

import { uid, token } from '../lib/ids.mjs'
import { jurisdictionFor } from '../lib/jurisdictions/index.mjs'
import { changeFor, tenderedValue } from '../lib/change.mjs'
import { rateOn as fxRateOn, convertMoney, invert, PPM } from '../lib/fx.mjs'
import { post, accountByCode, accountBySubtype, PostingError } from './books.mjs'
import { promptPayPayload, parseSlipQr, normalisePayee } from '../lib/promptpay.mjs'
import { qrToSvg } from '../lib/qr.mjs'
import { format } from '../lib/money.mjs'
import { recordPayment, getDoc } from './documents.mjs'
import {
  wallets, walletUri, assetRateOn, assetForMoney, formatAsset,
} from './crypto.mjs'

/** Check a PromptPay id by building it, then store the digits people recognise.
 *  A bad id fails here rather than on a QR nobody can scan. */
function cleanPayee(id) {
  if (!id) return null
  normalisePayee(id)                       // throws on anything unusable
  return String(id).replace(/\D/g, '')
}

// ---- the ways to be paid ----------------------------------------------------

export const methodsFor = (db, entityId, { direction = 'in' } = {}) => db.all(
  `SELECT * FROM pay_method
    WHERE entity_id = ? AND is_active = 1 AND direction IN (?, 'both')
    ORDER BY is_default DESC, sort, label_en`, entityId, direction)

export async function addMethod(db, {
  entity_id, kind, label_en, label_th = null, payee_id = null, bank_name = null,
  account_name = null, account_no = null, link_template = null,
  account_code = '1010', direction = 'in', is_default = false, sort = 0, note = null,
}) {
  const id = uid()
  await db.run(
    `INSERT INTO pay_method(id, entity_id, kind, label_en, label_th, payee_id,
       bank_name, account_name, account_no, link_template, account_code, direction,
       is_default, sort, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, kind, label_en, label_th, cleanPayee(payee_id),
    bank_name, account_name, account_no, link_template, account_code, direction,
    is_default ? 1 : 0, sort, note)
  if (is_default) await setDefaultMethod(db, id)
  return db.get('SELECT * FROM pay_method WHERE id = ?', id)
}

/** One default per direction, so the payer is never asked to choose first. */
export async function setDefaultMethod(db, methodId) {
  const m = await db.get('SELECT * FROM pay_method WHERE id = ?', methodId)
  await db.run(
    'UPDATE pay_method SET is_default = 0 WHERE entity_id = ? AND direction = ?',
    m.entity_id, m.direction)
  await db.run('UPDATE pay_method SET is_default = 1 WHERE id = ?', methodId)
  return db.get('SELECT * FROM pay_method WHERE id = ?', methodId)
}

// ---- the satang tail --------------------------------------------------------

/**
 * A distinct 1–99 satang tail per open invoice, so the amount alone says which
 * invoice a bank credit belongs to. Seeded from the document id, so the same
 * document keeps its tail if it is re-issued.
 */
export function chooseTail(taken, seed = '') {
  const used = new Set(Array.from(taken, Number))
  let h = 0
  for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) >>> 0
  const start = (h % 99) + 1
  for (let i = 0; i < 99; i++) {
    const tail = ((start - 1 + i) % 99) + 1
    if (!used.has(tail)) return tail
  }
  return 0            // more than 99 invoices for the same amount: give up honestly
}

/**
 * Give an issued document its tail and its payment link.
 *
 * The tail is added to what the payer is ASKED for, not to the invoice total:
 * the books keep the true amount and the extra satang is written off when the
 * payment is recorded. The document says so in its own line.
 */
export async function preparePayment(db, docId) {
  const doc = await getDoc(db, docId)
  if (!doc || doc.direction !== 'out' || doc.kind === 'quote') return doc
  if (doc.pay_token && doc.pay_tail) return doc
  // A tail is only worth its oddness when somebody will pay by transfer.
  const transferable = await db.get(
    `SELECT COUNT(*) AS n FROM pay_method WHERE entity_id = ? AND is_active = 1
       AND kind IN ('promptpay','bank') AND direction IN ('in','both')`, doc.entity_id)
  if (!transferable?.n) {
    if (!doc.pay_token) await db.run('UPDATE doc SET pay_token = ? WHERE id = ?', token(10), docId)
    return getDoc(db, docId)
  }
  // The tail is NOT part of `expect_paid` — it is added when the payer is asked
  // — so invoices that clash are the ones with the same `expect_paid`. Taking
  // the tail off it here looked right and quietly matched nothing, which let
  // two invoices for the same amount draw the same tail about one time in a
  // hundred.
  const others = await db.all(
    `SELECT pay_tail FROM doc
      WHERE entity_id = ? AND direction = 'out' AND id <> ?
        AND status IN ('issued','part_paid') AND expect_paid = ? AND pay_tail > 0`,
    doc.entity_id, doc.id, doc.expect_paid)
  const tail = chooseTail(others.map((r) => r.pay_tail), doc.id)
  await db.run(
    'UPDATE doc SET pay_tail = ?, pay_token = COALESCE(pay_token, ?) WHERE id = ?',
    tail, token(10), docId)
  return getDoc(db, docId)
}

/** What to ask the payer for: the amount plus its tail. */
export const amountToAsk = (doc) => (doc.expect_paid ?? 0) + (doc.pay_tail ?? 0)

export const docByPayToken = (db, tokenValue) =>
  db.get('SELECT * FROM doc WHERE pay_token = ?', tokenValue)

// ---- what the payer sees ----------------------------------------------------

/**
 * Everything one method needs to show, ready to render: the QR payload for
 * PromptPay, the fields for a transfer form, or the link for a card page.
 */
export function payInstruction(method, {
  amount, reference = null, payeeName = null, city, currency = 'THB', locale = 'en',
}) {
  if (!method) return null
  const label = pickLabel(method, locale)

  // A scan-to-pay code the bank issues rather than this system building one:
  // KHQR through Bakong, and anything else shaped the same way. The payload is
  // rendered as it was given, which is why the amount sits beside it rather
  // than inside it.
  if (method.kind === 'qr' && method.qr_payload) {
    return {
      kind: 'qr',
      label,
      payload: method.qr_payload,
      qr: qrToSvg(method.qr_payload, { scale: 5, border: 1 }),
      amount,
      fixedAmount: true,
      lines: [
        [label, format(amount, currency)],
        reference ? ['Reference', reference] : null,
      ].filter(Boolean),
    }
  }
  if (method.kind === 'promptpay' && method.payee_id) {
    // PromptPay is a Thai scheme: the payload carries the payee and the amount.
    const payload = promptPayPayload({
      payeeId: method.payee_id,
      satang: amount,
      merchantName: payeeName || method.account_name || undefined,
      merchantCity: city || 'Chiang Rai',
      ref: reference || undefined,
    })
    return {
      kind: 'promptpay',
      label,
      payload,
      qr: qrToSvg(payload, { scale: 5, border: 1 }),
      amount,
      lines: [[method.label_en, method.payee_id]],
    }
  }
  if (method.kind === 'bank') {
    // Somebody sending from abroad needs the bank's SWIFT and address, and
    // their own bank's form will not accept a three-part local account number
    // on its own. Shown when recorded, absent when not, never invented.
    const abroad = method.abroad || {}
    return {
      kind: 'bank',
      label,
      amount,
      swift: abroad.swift || null,
      iban: abroad.iban || null,
      lines: [
        ['Bank', method.bank_name],
        ['Account name', method.account_name],
        ['Account number', method.account_no],
        abroad.swift ? ['SWIFT / BIC', abroad.swift] : null,
        abroad.iban ? ['IBAN', abroad.iban] : null,
        abroad.bank_address ? ['Bank address', abroad.bank_address] : null,
        ['Amount', format(amount, currency)],
        reference ? ['Reference', reference] : null,
      ].filter(Boolean),
    }
  }
  if (method.kind === 'link' && method.link_template) {
    const url = method.link_template
      .replace('{amount}', String(amount / 100))
      .replace('{ref}', encodeURIComponent(reference || ''))
    return { kind: 'link', label, url, amount, lines: [[label, url]] }
  }
  return { kind: method.kind, label, amount, lines: [[label, method.note || '']] }
}

/** The label in the reader's language, falling back rather than showing a gap. */
function pickLabel(method, locale) {
  if (locale === 'th') return method.label_th || method.label_en
  if (locale === 'km') return method.label_km || method.label_en
  return method.label_en || method.label_th || method.label_km
}

/**
 * Which way of being paid this country actually uses, for a set of books that
 * has not set one up yet. Nothing is created automatically — it is what the
 * screen offers first.
 */
export function habitFor(country) {
  const pack = jurisdictionFor(country)
  return pack.HABITS || { scan_to_pay: 'bank', chat: 'chat', era: 'CE' }
}

/**
 * A wallet, as a way to pay: the address, its QR, and how much coin that comes
 * to at the rate recorded for the day — with the rate and its date shown,
 * because a coin price is a quote from somewhere at a moment.
 */
export async function cryptoInstruction(db, wallet, { amount, onDate, reference = null }) {
  const rate = await assetRateOn(db, wallet.asset, onDate)
  const units = rate ? assetForMoney(amount, wallet.asset, rate.rate_ppm) : null
  const uri = walletUri(wallet, { amount: units })
  return {
    kind: 'crypto',
    label: `${wallet.asset} · ${wallet.label}`,
    asset: wallet.asset,
    network: wallet.network,
    address: wallet.address,
    units,
    amount,
    rate: rate?.rate_ppm ?? null,
    rate_on: rate?.on_date ?? null,
    stale: rate ? rate.on_date < onDate : true,
    payload: uri,
    qr: uri ? qrToSvg(uri, { scale: 5, border: 1 }) : null,
    lines: [
      [wallet.asset, units == null ? '—' : formatAsset(units, wallet.asset)],
      ['Network', wallet.network || '—'],
      ['Address', wallet.address || '—'],
      rate ? ['Rate', `${(rate.rate_ppm / 1_000_000).toLocaleString('en-US')} per ${wallet.asset} · ${rate.on_date}`] : null,
      reference ? ['Reference', reference] : null,
    ].filter(Boolean),
  }
}

/** Every way to pay one document, default first, coin included. */
export async function waysToPay(db, docId, { onDate = null, locale = 'en' } = {}) {
  const doc = await preparePayment(db, docId)
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', doc.entity_id)
  const methods = await methodsFor(db, doc.entity_id, { direction: 'in' })
  const amount = amountToAsk(doc)
  const date = onDate || new Date().toISOString().slice(0, 10)
  // The international details live on the bank account, not on the button, so
  // one bank recorded once serves every way of being paid into it.
  const abroadBy = new Map()
  for (const a of await db.all(
    `SELECT code, swift, iban, bank_address FROM account
      WHERE entity_id = ? AND (swift IS NOT NULL OR iban IS NOT NULL OR bank_address IS NOT NULL)`,
    doc.entity_id)) abroadBy.set(a.code, a)
  const ways = methods.map((m) => payInstruction({ ...m, abroad: abroadBy.get(m.account_code) }, {
    amount,
    reference: doc.number,
    payeeName: entity.name_en,
    city: (entity.address_en || '').split(',').pop()?.trim(),
    currency: doc.currency || entity.currency,
    locale,
  })).filter(Boolean)

  for (const w of await wallets(db, doc.entity_id, { direction: 'in' })) {
    if (!w.address) continue
    ways.push(await cryptoInstruction(db, w, { amount, onDate: date, reference: doc.number }))
  }

  return { doc, amount, reference: doc.number, ways }
}

/** The mirror: a QR for paying a supplier or a person who gave you their id. */
export function waysToPayThem(party, { amount, reference = null }) {
  const out = []
  if (party?.pay_promptpay) {
    out.push(payInstruction(
      { kind: 'promptpay', label_en: 'PromptPay', payee_id: party.pay_promptpay },
      { amount, reference, payeeName: party.name_en }))
  }
  if (party?.pay_account_no) {
    out.push(payInstruction({
      kind: 'bank', label_en: 'Bank transfer', bank_name: party.pay_bank,
      account_name: party.pay_account_name || party.name_en, account_no: party.pay_account_no,
    }, { amount, reference }))
  }
  return out
}

// ---- what came back ---------------------------------------------------------

/**
 * A payer saying they have paid. Recorded, shown beside the invoice, and
 * settling nothing on its own.
 */
export async function claimPaid(db, {
  entity_id, doc_id, amount = null, method = null, slip_raw = null,
  photo_name = null, note = null, idem_key = null,
}) {
  if (idem_key) {
    const seen = await db.get('SELECT * FROM pay_claim WHERE idem_key = ?', idem_key)
    if (seen) return seen
  }
  const parsed = slip_raw ? parseSlipQr(slip_raw) : null
  const id = uid()
  await db.run(
    `INSERT INTO pay_claim(id, entity_id, doc_id, amount, method, slip_ref, slip_raw,
       photo_name, note, idem_key)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, doc_id, amount, method, parsed?.ref ?? null, slip_raw,
    photo_name, note, idem_key)
  return db.get('SELECT * FROM pay_claim WHERE id = ?', id)
}

export const claimsFor = (db, entityId, { status = 'new' } = {}) => db.all(
  `SELECT c.*, d.number, d.expect_paid, d.pay_tail, y.name_en AS party_name_en,
          y.name_th AS party_name_th,
            y.name_km AS party_name_km
     FROM pay_claim c
     LEFT JOIN doc d ON d.id = c.doc_id
     LEFT JOIN party y ON y.id = d.party_id
    WHERE c.entity_id = ? AND (? IS NULL OR c.status = ?)
    ORDER BY c.claimed_at DESC`, entityId, status, status)

/**
 * Which invoice a credit of this amount belongs to.
 *
 * The tail makes an exact match near-certain; without one, an exact amount is
 * only a suggestion, and a close amount is a question for a person. Nothing
 * here settles anything — it ranks.
 */
export async function matchIncoming(db, entityId, { amount, party_id = null }) {
  const open = await db.all(
    `SELECT d.*, y.name_en AS party_name_en FROM doc d JOIN party y ON y.id = d.party_id
      WHERE d.entity_id = ? AND d.direction = 'out' AND d.kind <> 'quote'
        AND d.status IN ('issued','part_paid')`, entityId)
  const out = []
  for (const d of open) {
    const asked = amountToAsk(d) - d.paid - d.wht_credited
    const samePayer = party_id && party_id === d.party_id
    if (amount === asked && d.pay_tail) {
      out.push({ doc: d, confidence: samePayer ? 99 : 95, why: 'exact amount, unique tail' })
    } else if (amount === asked && samePayer) {
      out.push({ doc: d, confidence: 90, why: 'exact amount from this payer' })
    } else if (amount === asked) {
      out.push({ doc: d, confidence: 55, why: 'exact amount, more than one it could be' })
    } else if (samePayer && amount < asked) {
      out.push({ doc: d, confidence: 45, why: 'part payment from this payer' })
    } else if (Math.abs(amount - asked) <= 100) {
      out.push({ doc: d, confidence: 20, why: 'within a baht of the amount asked' })
    }
  }
  out.sort((a, b) => b.confidence - a.confidence)
  return out
}

export const AUTO_MATCH = 90

/** Safe to apply without a person looking: high confidence, and no runner-up. */
export const isClear = (ranked) =>
  ranked.length > 0 && ranked[0].confidence >= AUTO_MATCH &&
  !(ranked.length > 1 && ranked[1].confidence === ranked[0].confidence)

/**
 * Settle an invoice from the bank in one step: the cash, the certificate, and
 * the odd satang of the tail written off so the document closes exactly.
 */
export async function settleInFull(db, docId, {
  on_date, account = '1010', method = 'transfer', slip_ref = null,
  claim_id = null, posted_by = null,
}) {
  const doc = await getDoc(db, docId)
  const outstanding = doc.gross - doc.paid - doc.wht_credited
  const wht = Math.min(doc.wht - doc.wht_credited, outstanding)
  const cash = outstanding - wht
  const payment = await recordPayment(db, {
    entity_id: doc.entity_id,
    direction: 'in',
    on_date,
    party_id: doc.party_id,
    account,
    method,
    amount: cash,
    wht_amount: wht,
    wht_cert_no: wht ? `WHT-${doc.number}` : null,
    slip_ref,
    idem_key: `settle:${docId}`,
    posted_by,
    allocations: [{ doc_id: docId, amount: cash, wht_amount: wht }],
  })
  if (claim_id) {
    await db.run(
      "UPDATE pay_claim SET status = 'matched', payment_id = ? WHERE id = ?",
      payment.id, claim_id)
  }
  return payment
}

// ---- the counter ------------------------------------------------------------

/**
 * Cash across the counter in a place that prices in one currency and gives
 * change in another.
 *
 * A $17.40 bill, a twenty-dollar note, and the change is two dollars and two
 * thousand five hundred riel. Every till in Phnom Penh does this and the
 * arithmetic usually happens on somebody's phone, so it happens here instead:
 * the split is computed, shown, and posted — including the few riel the
 * rounding costs, which lands in its own line rather than in the takings.
 */
export async function takeCash(db, {
  entity_id, doc_id = null, tendered = [], on_date, round = 'up',
  primary_account = null, change_account = null, posted_by = null, note = null,
}) {
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entity_id)
  const pack = jurisdictionFor(entity?.country)
  const books = entity?.currency || pack.CURRENCY
  const changeCcy = pack.CHANGE_CURRENCY || books
  const roundTo = pack.CHANGE_ROUNDING || 1

  const doc = doc_id ? await getDoc(db, doc_id) : null
  const due = doc ? doc.gross - doc.paid - doc.wht_credited : 0

  // What the rate is today, if the two currencies differ at all.
  let rate = null
  if (changeCcy !== books) {
    const found = await fxRateOn(db, books, changeCcy, on_date, { through: books })
    if (!found) {
      throw new PostingError('no_fx_rate',
        `No rate for ${books} to ${changeCcy} on ${on_date}; change cannot be worked out.`)
    }
    rate = found.rate_ppm
  }

  const handed = tenderedValue(tendered, { currency: books, rate_ppm: rate })
  const split = changeFor({
    due, tendered: handed, currency: books, change_in: changeCcy,
    rate_ppm: rate, round_to: roundTo, round,
  })
  if (!split.enough) {
    throw new PostingError('short', `Still ${split.short} to come.`, { short: split.short })
  }

  // Where the notes go and where the change comes from.
  const cashIn = primary_account
    ? await accountByCode(db, entity_id, primary_account)
    : await firstCashAccount(db, entity_id, books, books)
  const cashChange = changeCcy === books
    ? cashIn
    : (change_account
      ? await accountByCode(db, entity_id, change_account)
      : await firstCashAccount(db, entity_id, changeCcy, books)) || cashIn
  if (!cashIn) throw new PostingError('no_account', `No ${books} cash account to take it into.`)

  const control = await accountBySubtype(db, entity_id, 'ar')
  const roundingAcct = await accountByCode(db, entity_id, '6900')

  // Net movement per drawer: what came in, less what went back out.
  const inPrimary = tendered
    .filter((x) => (x.currency || books) === books)
    .reduce((a, x) => a + (x.amount || 0), 0) - split.whole
  const inChangeCcy = tendered
    .filter((x) => (x.currency || books) === changeCcy && changeCcy !== books)
    .reduce((a, x) => a + (x.amount || 0), 0) - split.small

  const lines = []
  if (inPrimary) lines.push({ account: cashIn.id, amount: inPrimary, currency: books })
  if (inChangeCcy && rate) {
    lines.push({
      account: cashChange.id,
      amount: convertMoney(inChangeCcy, invert(rate), changeCcy, books),
      currency: changeCcy,
      fx_amount: inChangeCcy,
      fx_rate_ppm: invert(rate),
    })
  }
  if (doc) lines.push({ account: control.id, amount: -due, party_id: doc.party_id })

  // The rounding: a few riel either way, named rather than absorbed.
  const drift = lines.reduce((a, l) => a + l.amount, 0)
  if (drift && roundingAcct) {
    lines.push({ account: roundingAcct.id, amount: -drift, memo: 'change rounding' })
  }

  const journal = await post(db, {
    entity_id,
    on_date,
    memo_en: doc ? `Cash for ${doc.number}` : 'Cash taken',
    source_kind: 'cash',
    source_id: doc_id,
    posted_by,
    lines,
  })

  if (doc) {
    const id = uid()
    await db.run(
      `INSERT INTO payment(id, entity_id, direction, on_date, party_id, account_id,
         method, currency, amount, wht_amount, note, journal_id, booked_amount, fx_rate_ppm)
       VALUES (?,?,'in',?,?,?,'cash',?,?,0,?,?,?,?)`,
      id, entity_id, on_date, doc.party_id, cashIn.id, books, due, note,
      journal.id, due, PPM)
    await db.run(
      'INSERT INTO allocation(id, payment_id, doc_id, amount, wht_amount) VALUES (?,?,?,?,0)',
      uid(), id, doc.id, due)
    await db.run(
      `UPDATE doc SET paid = paid + ?, status = CASE WHEN paid + ? + wht_credited >= gross
         THEN 'paid' ELSE 'part_paid' END WHERE id = ?`, due, due, doc.id)
  }

  return { ...split, journal, due, handed, rate, change_currency: changeCcy }
}

/**
 * The drawer for a currency. An account with no currency of its own is the
 * books' own currency — NOT whichever one is being asked for, which would let
 * riel change come out of a dollar account and balance anyway.
 */
async function firstCashAccount(db, entityId, currency, booksCurrency) {
  return db.get(
    `SELECT * FROM account WHERE entity_id = ? AND subtype = 'cash' AND is_active = 1
       AND COALESCE(currency, ?) = ? ORDER BY is_bank, code LIMIT 1`,
    entityId, booksCurrency, currency)
}
