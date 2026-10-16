// stock.mjs — pieces through the books: bought, prepared, listed, sold.
//
// The ledger side of stock is two postings and the discipline is keeping them
// apart. Buying moves money into an asset (Dr stock, Cr cash or the supplier).
// Selling does two separate things on the same day: it earns revenue from the
// customer, and it takes the piece OUT of the asset at what it cost
// (Dr cost of goods sold, Cr stock). Margin is then a fact in the ledger
// rather than a number somebody works out in their head.
//
// A bundle is bought at one price and split across its pieces at intake. The
// split is recorded, not just applied, because "why does this piece cost ฿412"
// is asked a year later and the honest answer is arithmetic.

import { uid } from '../lib/ids.mjs'
import { splitByWeights } from '../lib/money.mjs'
import { post, accountBySubtype, accountByCode, PostingError } from './books.mjs'
import { draft, issue, recordPayment } from './documents.mjs'

const move = async (db, item_id, kind, fields = {}) => {
  const id = uid()
  await db.run(
    `INSERT INTO item_move(id, item_id, on_date, kind, from_status, to_status,
       amount, location, person_id, doc_id, journal_id, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, item_id, fields.on_date, kind, fields.from_status ?? null, fields.to_status ?? null,
    fields.amount ?? null, fields.location ?? null, fields.person_id ?? null,
    fields.doc_id ?? null, fields.journal_id ?? null, fields.note ?? null)
  return id
}

/**
 * Take a piece into stock.
 *
 * `paid_from` is a cash account code for a piece paid for on the spot; a piece
 * bought on a supplier bill passes `party_id` and leaves the credit on
 * payables instead.
 */
export async function acquire(db, {
  entity_id, project_id = null, sku, name_en, name_th = null, name_km = null, category = null,
  tradition = null, series = null, year_be = null, condition = null,
  acq_cost = 0, acq_date, acq_lot = null, location = null, ask_price = null,
  party_id = null, paid_from = '1000', posted_by = null, note = null,
}) {
  const existing = await db.get('SELECT * FROM item WHERE entity_id = ? AND sku = ?', entity_id, sku)
  if (existing) return existing
  const id = uid()
  await db.run(
    `INSERT INTO item(id, entity_id, project_id, sku, name_en, name_th, name_km, category,
       tradition, series, year_be, condition, acq_cost, acq_doc_id, acq_date,
       acq_lot, ask_price, status, location, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,'in_stock',?,?)`,
    id, entity_id, project_id, sku, name_en, name_th, name_km, category, tradition, series,
    year_be, condition, acq_cost, acq_date, acq_lot, ask_price, location, note)

  let journal = null
  if (acq_cost) {
    const stock = await accountBySubtype(db, entity_id, 'stock')
    const credit = party_id
      ? await accountBySubtype(db, entity_id, 'ap')
      : await accountByCode(db, entity_id, paid_from)
    journal = await post(db, {
      entity_id,
      on_date: acq_date,
      memo_en: `Stock in: ${sku}`,
      source_kind: 'item',
      source_id: id,
      idem_key: `item:acquire:${id}`,
      posted_by,
      lines: [
        { account: stock.id, amount: acq_cost, project_id, memo: sku },
        { account: credit.id, amount: -acq_cost, party_id, project_id, memo: sku },
      ],
    })
  }
  await move(db, id, 'acquire', {
    on_date: acq_date, to_status: 'in_stock', amount: acq_cost,
    location, journal_id: journal?.id, note,
  })
  return db.get('SELECT * FROM item WHERE id = ?', id)
}

/**
 * Split one bundle price across the pieces that came in it. `basis` decides
 * the weights: evenly, or in proportion to what each is expected to fetch.
 * Nothing is lost — the odd satang go to the largest share.
 */
export async function splitLot(db, { entity_id, acq_lot, total, basis = 'even', on_date, posted_by = null }) {
  const items = await db.all(
    'SELECT * FROM item WHERE entity_id = ? AND acq_lot = ? ORDER BY sku', entity_id, acq_lot)
  if (!items.length) throw new PostingError('not_found', `No pieces in lot ${acq_lot}.`)
  const weights = basis === 'by_ask'
    ? items.map((i) => Math.max(1, i.ask_price || 1))
    : items.map(() => 1)
  const shares = splitByWeights(total, weights)

  const already = items.reduce((a, i) => a + i.acq_cost, 0)
  for (const [n, it] of items.entries()) {
    await db.run('UPDATE item SET acq_cost = ? WHERE id = ?', shares[n], it.id)
    await db.run(
      `INSERT INTO lot_split(id, acq_lot, item_id, basis, weight_milli, amount)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(acq_lot, item_id) DO UPDATE SET basis = excluded.basis,
         weight_milli = excluded.weight_milli, amount = excluded.amount`,
      uid(), acq_lot, it.id, basis, weights[n] * 1000, shares[n])
  }
  // Only the difference needs posting: the pieces may already carry a cost
  // from intake, and re-posting the whole lot would double the asset.
  const delta = total - already
  if (delta) {
    const stock = await accountBySubtype(db, entity_id, 'stock')
    const cash = await accountByCode(db, entity_id, '1000')
    await post(db, {
      entity_id,
      on_date,
      memo_en: `Lot ${acq_lot} cost apportioned`,
      source_kind: 'lot',
      source_id: acq_lot,
      idem_key: `lot:${acq_lot}:${total}`,
      posted_by,
      lines: [
        { account: stock.id, amount: delta, memo: acq_lot },
        { account: cash.id, amount: -delta, memo: acq_lot },
      ],
    })
  }
  return db.all('SELECT * FROM item WHERE entity_id = ? AND acq_lot = ? ORDER BY sku',
    entity_id, acq_lot)
}

/** Cleaning, a case, a new cord, postage in — cost that belongs to the piece. */
export async function addPrepCost(db, itemId, { amount, on_date, paid_from = '1000', posted_by = null, note = null }) {
  const it = await db.get('SELECT * FROM item WHERE id = ?', itemId)
  const stock = await accountBySubtype(db, it.entity_id, 'stock')
  const cash = await accountByCode(db, it.entity_id, paid_from)
  const journal = await post(db, {
    entity_id: it.entity_id,
    on_date,
    memo_en: `Preparation: ${it.sku}`,
    source_kind: 'item',
    source_id: itemId,
    posted_by,
    lines: [
      { account: stock.id, amount, project_id: it.project_id, memo: it.sku },
      { account: cash.id, amount: -amount, project_id: it.project_id, memo: it.sku },
    ],
  })
  await db.run('UPDATE item SET prep_cost = prep_cost + ? WHERE id = ?', amount, itemId)
  await move(db, itemId, 'prep', { on_date, amount, journal_id: journal.id, note })
  return db.get('SELECT * FROM item WHERE id = ?', itemId)
}

export async function setStatus(db, itemId, status, { on_date, location = null, listing_url = null, ask_price = null, note = null } = {}) {
  const it = await db.get('SELECT * FROM item WHERE id = ?', itemId)
  await db.run(
    `UPDATE item SET status = ?, location = COALESCE(?, location),
       listing_url = COALESCE(?, listing_url), ask_price = COALESCE(?, ask_price)
     WHERE id = ?`, status, location, listing_url, ask_price, itemId)
  const kind = { listed: 'list', reserved: 'reserve', in_stock: 'unlist',
    returned: 'return', gifted: 'gift', written_off: 'write_off' }[status] || 'move'
  await move(db, itemId, kind, { on_date, from_status: it.status, to_status: status, location, note })
  return db.get('SELECT * FROM item WHERE id = ?', itemId)
}

/**
 * Sell a piece. Raises the sales document, posts the cost out of stock, and —
 * when `paid_to` is given — records the money landing on the same day, which
 * is what a market sale actually looks like.
 */
export async function sell(db, itemId, {
  party_id, price, on_date, paid_to = null, method = 'transfer', wht_bp = 0,
  kind = 'invoice', posted_by = null, slip_ref = null, revenue_account = '4000',
}) {
  const it = await db.get('SELECT * FROM item WHERE id = ?', itemId)
  if (!it) throw new PostingError('not_found', 'No such piece.')
  if (it.status === 'sold') throw new PostingError('already_sold', `${it.sku} is already sold.`)
  const revenue = await accountByCode(db, it.entity_id, revenue_account)

  const doc = await issue(db, (await draft(db, {
    entity_id: it.entity_id,
    kind,
    party_id,
    project_id: it.project_id,
    issue_date: on_date,
    wht_bp,
    subject_en: it.name_en,
    subject_th: it.name_th,
    idem_key: `sale:${itemId}`,
    lines: [{
      desc_en: `${it.name_en} (${it.sku})`,
      desc_th: it.name_th,
      unit_price: price,
      tax_code: 'NONE',
      account_id: revenue.id,
      project_id: it.project_id,
      item_id: itemId,
    }],
  })).id, { posted_by })

  const cost = it.acq_cost + it.prep_cost
  let cogsJournal = null
  if (cost) {
    const stock = await accountBySubtype(db, it.entity_id, 'stock')
    const cogs = await accountBySubtype(db, it.entity_id, 'cogs')
    cogsJournal = await post(db, {
      entity_id: it.entity_id,
      on_date,
      memo_en: `Cost of sale: ${it.sku}`,
      source_kind: 'item',
      source_id: itemId,
      idem_key: `item:cogs:${itemId}`,
      posted_by,
      lines: [
        { account: cogs.id, amount: cost, project_id: it.project_id, memo: it.sku },
        { account: stock.id, amount: -cost, project_id: it.project_id, memo: it.sku },
      ],
    })
  }

  await db.run(
    `UPDATE item SET status = 'sold', sold_price = ?, sold_doc_id = ?, sold_date = ?
     WHERE id = ?`, price, doc.id, on_date, itemId)
  await move(db, itemId, 'sell', {
    on_date, from_status: it.status, to_status: 'sold', amount: price,
    doc_id: doc.id, journal_id: cogsJournal?.id,
  })

  let payment = null
  if (paid_to) {
    payment = await recordPayment(db, {
      entity_id: it.entity_id,
      direction: 'in',
      on_date,
      party_id,
      account: paid_to,
      method,
      amount: doc.expect_paid,
      wht_amount: doc.wht,
      slip_ref,
      posted_by,
      idem_key: `sale:paid:${itemId}`,
      allocations: [{ doc_id: doc.id, amount: doc.expect_paid, wht_amount: doc.wht }],
    })
  }
  return { item: await db.get('SELECT * FROM item WHERE id = ?', itemId), doc, payment }
}

/** What is held and what it cost — the number that should equal account 1200. */
export async function valuation(db, entityId, { project_id = null } = {}) {
  const rows = await db.all(
    `SELECT status, COUNT(*) AS pieces, SUM(acq_cost + prep_cost) AS cost,
            SUM(COALESCE(ask_price,0)) AS asking
       FROM item
      WHERE entity_id = ? AND (? IS NULL OR project_id = ?)
        AND status IN ('in_stock','listed','reserved')
      GROUP BY status`, entityId, project_id, project_id)
  const total = rows.reduce((a, r) => a + (r.cost || 0), 0)
  const pieces = rows.reduce((a, r) => a + r.pieces, 0)
  return { rows, total, pieces }
}

/** Margin on what sold in a span, piece by piece. */
export async function margin(db, entityId, { from, to, project_id = null } = {}) {
  const rows = await db.all(
    `SELECT sku, name_en, name_th, category, sold_date, sold_price,
            acq_cost + prep_cost AS cost,
            sold_price - (acq_cost + prep_cost) AS margin,
            acq_date
       FROM item
      WHERE entity_id = ? AND status = 'sold'
        AND (? IS NULL OR sold_date >= ?) AND (? IS NULL OR sold_date <= ?)
        AND (? IS NULL OR project_id = ?)
      ORDER BY sold_date DESC`,
    entityId, from ?? null, from ?? null, to ?? null, to ?? null,
    project_id, project_id)
  const revenue = rows.reduce((a, r) => a + (r.sold_price || 0), 0)
  const cost = rows.reduce((a, r) => a + (r.cost || 0), 0)
  // Days from intake to sale — the number that says whether a category is
  // worth buying again.
  const held = rows
    .filter((r) => r.acq_date && r.sold_date)
    .map((r) => Math.round(
      (Date.parse(`${r.sold_date}T00:00:00Z`) - Date.parse(`${r.acq_date}T00:00:00Z`)) / 86400000))
  const medianHeld = held.length
    ? held.sort((a, b) => a - b)[Math.floor(held.length / 2)] : null
  return { rows, revenue, cost, margin: revenue - cost, medianDaysHeld: medianHeld }
}
