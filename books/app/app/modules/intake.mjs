// intake.mjs — the ways things get in.
//
// A client is not going to learn the books. So the client's side of this is one
// screen with three fields and a camera, reached by a link, a forwarded email, a
// chat message, or the QR on a bank slip — and the bookkeeper's side is a list
// of what arrived, each row already carrying a guess at the supplier and the
// account.
//
// THE GUESS NEVER POSTS. It fills a draft, the draft is read by a person, and
// the ledger only moves when they say so. A wrong guess costs a tap; a guess
// that posted itself would cost a return.

import { uid, token } from '../lib/ids.mjs'
import { vatBpOn } from '../lib/tax.mjs'
import { accountByCode } from './books.mjs'
import { draft } from './documents.mjs'

/** Words that reliably name a kind of spending, in both languages. The list is
 *  short on purpose: a guess that is usually right and visibly a guess beats a
 *  clever one nobody can predict. */
export const ACCOUNT_HINTS = [
  ['6100', ['rent', 'lease', 'ค่าเช่า', 'เช่าอาคาร']],
  ['6110', ['electric', 'water', 'utility', 'ค่าไฟ', 'ค่าน้ำ', 'ประปา']],
  ['6200', ['hosting', 'software', 'subscription', 'internet', 'อินเทอร์เน็ต', 'ซอฟต์แวร์']],
  ['6210', ['domain', 'โดเมน']],
  ['6300', ['fuel', 'petrol', 'taxi', 'grab', 'flight', 'ticket', 'น้ำมัน', 'ค่าเดินทาง', 'แท็กซี่']],
  ['6310', ['lunch', 'dinner', 'restaurant', 'coffee', 'อาหาร', 'กาแฟ', 'เลี้ยง']],
  ['6400', ['lawyer', 'legal', 'accountant', 'audit', 'consult', 'ทนาย', 'บัญชี', 'ที่ปรึกษา']],
  ['6410', ['government', 'immigration', 'dbd', 'revenue', 'fee', 'ราชการ', 'ตรวจคนเข้าเมือง', 'ค่าธรรมเนียม']],
  ['6500', ['bank fee', 'transfer fee', 'ค่าธรรมเนียมธนาคาร']],
  ['6600', ['advert', 'marketing', 'facebook', 'boost', 'โฆษณา', 'การตลาด']],
  ['6700', ['print', 'stationery', 'supplies', 'equipment', 'พิมพ์', 'อุปกรณ์', 'เครื่องเขียน']],
  ['5100', ['courier', 'shipping', 'post', 'ส่งของ', 'ไปรษณีย์', 'ขนส่ง']],
  ['6900', ['laundry', 'cleaning', 'ซักรีด', 'ทำความสะอาด']],
]

export function guessAccount(text) {
  const hay = String(text || '').toLowerCase()
  for (const [code, words] of ACCOUNT_HINTS) {
    if (words.some((w) => hay.includes(w))) return code
  }
  return null
}

/** Match what the sender typed against the parties already on file. An exact
 *  tax id is certainty; a name that contains the other is a suggestion. */
export async function guessParty(db, entityId, { hint, tax_id }) {
  if (tax_id) {
    const byTax = await db.get(
      'SELECT * FROM party WHERE entity_id = ? AND tax_id = ?', entityId, tax_id)
    if (byTax) return { party: byTax, confidence: 95, why: 'tax id' }
  }
  const text = String(hint || '').trim().toLowerCase()
  if (!text) return { party: null, confidence: 0, why: null }
  const all = await db.all(
    "SELECT * FROM party WHERE entity_id = ? AND status = 'active'", entityId)
  const exact = all.find((p) =>
    p.name_en?.toLowerCase() === text || p.name_th?.toLowerCase() === text)
  if (exact) return { party: exact, confidence: 90, why: 'name' }
  const partial = all.find((p) =>
    (p.name_en && (p.name_en.toLowerCase().includes(text) || text.includes(p.name_en.toLowerCase()))) ||
    (p.name_th && (p.name_th.includes(text) || text.includes(p.name_th))))
  if (partial) return { party: partial, confidence: 60, why: 'part of the name' }
  return { party: null, confidence: 0, why: null }
}

// ---- channels ---------------------------------------------------------------

export async function openChannel(db, { entity_id, kind, label = null, address = null }) {
  const value = address || (kind === 'link' ? token(12) : null)
  if (!value) throw new Error(`A ${kind} channel needs an address.`)
  const seen = await db.get(
    'SELECT * FROM intake_channel WHERE entity_id = ? AND kind = ? AND address = ?',
    entity_id, kind, value)
  if (seen) return seen
  const id = uid()
  await db.run(
    `INSERT INTO intake_channel(id, entity_id, kind, address, label)
     VALUES (?,?,?,?,?)`, id, entity_id, kind, value, label)
  return db.get('SELECT * FROM intake_channel WHERE id = ?', id)
}

export const channelsFor = (db, entityId) => db.all(
  'SELECT * FROM intake_channel WHERE entity_id = ? ORDER BY kind', entityId)

/** Replace a link's token — what you do when a link has been shared too widely. */
export async function rotateLink(db, channelId) {
  await db.run('UPDATE intake_channel SET address = ? WHERE id = ?', token(12), channelId)
  return db.get('SELECT * FROM intake_channel WHERE id = ?', channelId)
}

export const intakeUrl = (base, channel) =>
  `${String(base).replace(/\/$/, '')}/?in=${channel.address}`

export const channelByAddress = (db, address) =>
  db.get("SELECT * FROM intake_channel WHERE address = ? AND is_active = 1", address)

// ---- arrivals ---------------------------------------------------------------

/**
 * Something arrived. Stored as sent, with the guesses beside it.
 *
 * `idem_key` makes a resend harmless — the same photo forwarded twice by a
 * client who was not sure it went through is one item, not two.
 */
export async function receive(db, {
  entity_id, channel_id = null, source = 'link', from_ref = null, on_date = null,
  kind = 'unknown', description = null, amount = null, currency = 'THB', vat = null,
  tax_id = null, slip_ref = null, party_hint = null, photo_name = null,
  photo_data = null, note = null, idem_key = null,
}) {
  if (idem_key) {
    const seen = await db.get('SELECT * FROM inbox_item WHERE idem_key = ?', idem_key)
    if (seen) return seen
  }
  const guess = await guessParty(db, entity_id, { hint: party_hint, tax_id })
  const account = guessAccount(`${description || ''} ${party_hint || ''}`)
  const id = uid()
  await db.run(
    `INSERT INTO inbox_item(id, entity_id, channel_id, source, on_date, from_ref,
       kind, description, amount, currency, vat, tax_id, slip_ref, party_id,
       party_hint, account_hint, confidence, photo_name, photo_data, note, idem_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, channel_id, source, on_date, from_ref, kind, description, amount,
    currency, vat, tax_id, slip_ref, guess.party?.id ?? null, party_hint, account,
    guess.confidence, photo_name, photo_data, note, idem_key)
  return db.get('SELECT * FROM inbox_item WHERE id = ?', id)
}

export const inbox = (db, entityId, { status = 'new', limit = 100 } = {}) => db.all(
  `SELECT i.*, y.name_en AS party_name_en, y.name_th AS party_name_th,
            y.name_km AS party_name_km
     FROM inbox_item i LEFT JOIN party y ON y.id = i.party_id
    WHERE i.entity_id = ? AND (? IS NULL OR i.status = ?)
    ORDER BY i.received_at DESC LIMIT ?`, entityId, status, status, limit)

/** How much is waiting, per entity — the practice's own worklist. */
export const inboxCounts = (db) => db.all(
  `SELECT entity_id, COUNT(*) AS n FROM inbox_item WHERE status = 'new' GROUP BY entity_id`)

/**
 * Turn an arrival into a DRAFT — a supplier bill by default, or an invoice when
 * the client is telling you they billed someone. The draft carries the guess;
 * whoever opens it decides.
 */
export async function toDraft(db, itemId, {
  party_id = null, account_code = null, project_id = null, kind = null,
  issue_date = null, amount = null, vat_included = true, person_id = null,
} = {}) {
  const item = await db.get('SELECT * FROM inbox_item WHERE id = ?', itemId)
  if (!item) throw new Error('No such item.')
  if (item.status === 'used') return db.get('SELECT * FROM doc WHERE id = ?', item.doc_id)

  const party = party_id || item.party_id
  if (!party) throw new Error('This item has no supplier yet.')
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', item.entity_id)
  const docKind = kind || (item.kind === 'invoice' ? 'invoice' : 'bill')
  const code = account_code || item.account_hint || '6900'
  const account = await accountByCode(db, item.entity_id, code)

  const on = issue_date || item.on_date || new Date().toISOString().slice(0, 10)

  // A receipt shows the amount someone actually paid, VAT inside it. The line
  // is stored net, so the VAT the entity can claim is the figure on the
  // receipt rather than one worked backwards twice — at whichever rate was in
  // force where these books are kept.
  const gross = amount ?? item.amount ?? 0
  const vatBp = entity.vat_registered
    ? await vatBpOn(db, on, String(entity.country || 'TH').toUpperCase()) : 0
  const net = vat_included && vatBp ? gross - Math.round((gross * vatBp) / (10000 + vatBp)) : gross

  const terms = (await db.get('SELECT terms_days FROM party WHERE id = ?', party))?.terms_days ?? 0
  const d = await draft(db, {
    entity_id: item.entity_id,
    kind: docKind,
    party_id: party,
    project_id,
    issue_date: on,
    due_date: terms
      ? new Date(Date.parse(`${on}T00:00:00Z`) + terms * 86400000).toISOString().slice(0, 10)
      : on,
    subject_en: item.description,
    note_en: item.from_ref ? `Sent by ${item.from_ref}` : null,
    ref_external: item.slip_ref,
    idem_key: `inbox:${item.id}`,
    lines: [{
      desc_en: item.description || 'From the inbox',
      unit_price: net,
      tax_code: vat_included && vatBp ? 'VAT7' : 'NONE',
      account_id: account?.id ?? null,
      project_id,
    }],
  })
  await db.run("UPDATE inbox_item SET status = 'used', doc_id = ? WHERE id = ?", d.id, itemId)
  await db.run(
    `INSERT INTO audit(id, entity_id, person_id, action, object_kind, object_id, detail)
     VALUES (?,?,?,'intake.used','inbox_item',?,?)`,
    uid(), item.entity_id, person_id, itemId,
    JSON.stringify({ doc: d.id, guessed: item.account_hint, used: code }))
  return d
}

export async function dismiss(db, itemId, { why = null, person_id = null } = {}) {
  await db.run(
    "UPDATE inbox_item SET status = 'dismissed', dismissed_why = ? WHERE id = ?", why, itemId)
  await db.run(
    `INSERT INTO audit(id, entity_id, person_id, action, object_kind, object_id, detail)
     VALUES (?,(SELECT entity_id FROM inbox_item WHERE id = ?),?,'intake.dismissed','inbox_item',?,?)`,
    uid(), itemId, person_id, itemId, JSON.stringify({ why }))
  return db.get('SELECT * FROM inbox_item WHERE id = ?', itemId)
}
