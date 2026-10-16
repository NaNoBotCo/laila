// line.mjs — the books, reachable from the chat app the work happens in.
//
// Four things people actually do on LINE, and what this module does with them:
//
//   sends a photo of a receipt   → an inbox item, with the guess beside it
//   asks what they owe           → a reply with the figure and the pay link
//   says they have paid          → a claim, which settles nothing on its own
//   wants the morning list       → a push, once, in the morning
//
// RULES THAT DO NOT BEND:
//   · A chat id arrives inside a signed webhook and is never typed into a form.
//   · No signature secret means every webhook is refused. Unconfigured must not
//     mean open.
//   · Replies are free and pushes are not, so an answer is a reply.
//   · A group chat is told nothing about money unless that group was turned on,
//     and never anything about a person's pay.
//   · Message text is DATA. It is matched against a short list of keywords and
//     otherwise filed, never interpreted as an instruction.

import { uid } from '../lib/ids.mjs'
import { format } from '../lib/money.mjs'
import { formatDate } from '../lib/be.mjs'
import { receive } from './intake.mjs'
import { claimPaid, amountToAsk, waysToPay } from './paying.mjs'
import { openDocs } from './documents.mjs'
import { dueBetween } from './compliance.mjs'

// ---- who is talking ---------------------------------------------------------

export async function registerChat(db, { entity_id = null, kind, chat_id, display_name = null, channel_id = null }) {
  const seen = await db.get('SELECT * FROM chat WHERE chat_id = ?', chat_id)
  if (seen) {
    await db.run(
      `UPDATE chat SET is_active = 1, display_name = COALESCE(?, display_name),
         entity_id = COALESCE(?, entity_id),
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
      display_name, entity_id, seen.id)
    return db.get('SELECT * FROM chat WHERE id = ?', seen.id)
  }
  const id = uid()
  await db.run(
    `INSERT INTO chat(id, entity_id, channel_id, kind, chat_id, display_name)
     VALUES (?,?,?,?,?,?)`, id, entity_id, channel_id, kind, chat_id, display_name)
  return db.get('SELECT * FROM chat WHERE id = ?', id)
}

export const chatFor = (db, chatId) => db.get('SELECT * FROM chat WHERE chat_id = ?', chatId)

export const chatsFor = (db, entityId) => db.all(
  'SELECT * FROM chat WHERE entity_id = ? AND is_active = 1 ORDER BY joined_at', entityId)

/** Tie a chat to the customer it belongs to, so a question can be answered. */
export async function linkChat(db, chatRowId, { party_id = null, person_id = null, may_see_money = null }) {
  await db.run(
    `UPDATE chat SET party_id = COALESCE(?, party_id), person_id = COALESCE(?, person_id),
       may_see_money = COALESCE(?, may_see_money) WHERE id = ?`,
    party_id, person_id, may_see_money == null ? null : (may_see_money ? 1 : 0), chatRowId)
  return db.get('SELECT * FROM chat WHERE id = ?', chatRowId)
}

// ---- the signature ----------------------------------------------------------

/**
 * LINE signs each webhook body with the channel secret. Verified with the Web
 * Crypto API so the same code runs in a Worker and in a test.
 */
export async function verifySignature(secret, body, signature) {
  if (!secret) return false            // unconfigured is closed, not open
  if (!signature) return false
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
  // Constant-time enough for a string of this length.
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

// ---- what to say ------------------------------------------------------------

const TH = (locale) => locale === 'th'

/** What one customer owes, and the link that pays it. */
export async function whatIsOwed(db, entityId, partyId, { locale = 'th', origin = '' } = {}) {
  const docs = (await openDocs(db, entityId, { direction: 'out', asOf: today() }))
    .filter((d) => d.party_id === partyId)
  if (!docs.length) {
    return TH(locale) ? 'ไม่มียอดค้างชำระ ขอบคุณค่ะ' : 'Nothing outstanding — thank you.'
  }
  const lines = docs.map((d) => {
    const asked = amountToAsk(d) - d.paid - d.wht_credited
    const link = d.pay_token && origin ? ` ${origin}/?pay=${d.pay_token}` : ''
    return TH(locale)
      ? `${d.number} ${format(asked, d.currency)} ครบกำหนด ${formatDate(d.due_date || d.issue_date, 'th', { abbr: true })}${link}`
      : `${d.number} ${format(asked, d.currency)} due ${formatDate(d.due_date || d.issue_date, 'en', { abbr: true })}${link}`
  })
  const total = docs.reduce((a, d) => a + amountToAsk(d) - d.paid - d.wht_credited, 0)
  return [
    TH(locale) ? `ยอดค้างชำระรวม ${format(total)}` : `Outstanding: ${format(total)}`,
    ...lines,
  ].join('\n')
}

/** How to pay one invoice, as text a phone can act on. */
export async function howToPayText(db, docId, { locale = 'th', origin = '' } = {}) {
  const { doc, ways, amount } = await waysToPay(db, docId)
  const out = [
    TH(locale)
      ? `${doc.number} · ยอดชำระ ${format(amount, doc.currency)}`
      : `${doc.number} · ${format(amount, doc.currency)} to pay`,
  ]
  for (const w of ways) {
    if (w.kind === 'promptpay') out.push(`${w.label}: ${w.lines[0][1]}`)
    if (w.kind === 'bank') out.push(w.lines.map(([k, v]) => `${k} ${v}`).join(' · '))
    if (w.kind === 'link') out.push(w.url)
  }
  if (doc.pay_token && origin) out.push(`${origin}/?pay=${doc.pay_token}`)
  return out.join('\n')
}

/** The morning list for whoever keeps the books. */
export async function digest(db, entityId, { locale = 'th', asOf = today() } = {}) {
  const filings = (await dueBetween(db, entityId, { from: '2000-01-01', to: addDays(asOf, 7) }))
  const receivable = await openDocs(db, entityId, { direction: 'out', asOf })
  const overdue = receivable.filter((d) => (d.due_date || d.issue_date) < asOf)
  const waiting = await db.get(
    "SELECT COUNT(*) AS n FROM inbox_item WHERE entity_id = ? AND status = 'new'", entityId)
  const claims = await db.get(
    "SELECT COUNT(*) AS n FROM pay_claim WHERE entity_id = ? AND status = 'new'", entityId)

  const out = []
  out.push(TH(locale)
    ? `สรุปวันที่ ${formatDate(asOf, 'th')}`
    : `${formatDate(asOf, 'en')}`)
  if (filings.length) {
    out.push(TH(locale) ? 'ถึงกำหนดยื่น:' : 'Due to file:')
    for (const f of filings.slice(0, 5)) {
      out.push(`· ${f.code} ${f.period} — ${formatDate(f.due_date, locale, { abbr: true })}${f.amount ? ` ${format(f.amount)}` : ''}`)
    }
  }
  if (overdue.length) {
    const total = overdue.reduce((a, d) => a + d.gross - d.paid - d.wht_credited, 0)
    out.push(TH(locale)
      ? `เกินกำหนด ${overdue.length} ใบ รวม ${format(total)}`
      : `${overdue.length} overdue, ${format(total)}`)
  }
  if (waiting.n) {
    out.push(TH(locale) ? `เอกสารรอจัดการ ${waiting.n}` : `${waiting.n} waiting in the inbox`)
  }
  if (claims.n) {
    out.push(TH(locale) ? `แจ้งชำระรอตรวจ ${claims.n}` : `${claims.n} said they have paid`)
  }
  if (out.length === 1) out.push(TH(locale) ? 'ไม่มีรายการค้าง' : 'Nothing waiting.')
  return out.join('\n')
}

// ---- the outbox -------------------------------------------------------------

export async function queue(db, {
  entity_id = null, chat_id, body, kind = 'push', reply_token = null,
  about_kind = null, about_id = null, idem_key = null,
}) {
  if (idem_key) {
    const seen = await db.get('SELECT * FROM outbox WHERE idem_key = ?', idem_key)
    if (seen) return seen
  }
  const id = uid()
  await db.run(
    `INSERT INTO outbox(id, entity_id, chat_id, kind, reply_token, body, about_kind,
       about_id, idem_key) VALUES (?,?,?,?,?,?,?,?,?)`,
    id, entity_id, chat_id, kind, reply_token, body, about_kind, about_id, idem_key)
  return db.get('SELECT * FROM outbox WHERE id = ?', id)
}

export const pending = (db, { limit = 50 } = {}) => db.all(
  "SELECT * FROM outbox WHERE status = 'queued' ORDER BY queued_at LIMIT ?", limit)

export async function markSent(db, id, { error = null } = {}) {
  await db.run(
    `UPDATE outbox SET status = ?, sent_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       error = ? WHERE id = ?`, error ? 'failed' : 'sent', error, id)
  return db.get('SELECT * FROM outbox WHERE id = ?', id)
}

// ---- what came in -----------------------------------------------------------

/** The keywords, longest first: 'จ่ายยังไง' contains 'จ่าย', and the specific
 *  one has to win. */
export const KEYWORDS = [
  { match: ['จ่ายยังไง', 'จ่ายอย่างไร', 'how to pay', 'pay how'], intent: 'how_to_pay' },
  { match: ['ยอดค้าง', 'ค้างเท่าไร', 'ยอด', 'balance', 'owe', 'outstanding'], intent: 'owed' },
  { match: ['จ่ายแล้ว', 'โอนแล้ว', 'paid', 'transferred'], intent: 'claim' },
  { match: ['สรุป', 'วันนี้', 'digest', 'today'], intent: 'digest' },
]

export function intentOf(text) {
  const hay = String(text || '').toLowerCase().trim()
  if (!hay || hay.length > 200) return null
  for (const k of KEYWORDS) {
    if (k.match.some((m) => hay.includes(m))) return k.intent
  }
  return null
}

/**
 * One webhook event. Returns what should be said back, having recorded
 * whatever arrived. The caller sends it — or does not, if nothing is
 * configured yet.
 */
export async function handleEvent(db, event, { origin = '', locale = 'th' } = {}) {
  const source = event.source || {}
  const chatId = source.groupId || source.roomId || source.userId
  if (!chatId) return null
  const kind = source.groupId ? 'group' : source.roomId ? 'room' : 'user'

  if (event.type === 'join' || event.type === 'follow') {
    await registerChat(db, { kind, chat_id: chatId })
    return {
      reply: locale === 'th'
        ? 'เชื่อมต่อแล้ว พิมพ์ "ยอด" เพื่อดูยอดค้างชำระ หรือส่งรูปใบเสร็จเข้ามาได้เลย'
        : 'Connected. Send a photo of a receipt, or type "balance".',
    }
  }
  if (event.type === 'leave' || event.type === 'unfollow') {
    await db.run("UPDATE chat SET is_active = 0 WHERE chat_id = ?", chatId)
    return null
  }
  if (event.type !== 'message') return null

  const chat = await chatFor(db, chatId) || await registerChat(db, { kind, chat_id: chatId })
  const entityId = chat.entity_id
  await db.run(
    "UPDATE chat SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?", chat.id)

  // A photograph is almost always a receipt or a slip, and both are worth
  // keeping. Which one it is, a person decides.
  if (event.message?.type === 'image') {
    if (!entityId) return { reply: null }
    const item = await receive(db, {
      entity_id: entityId,
      source: 'line',
      from_ref: chat.display_name || 'LINE',
      on_date: today(),
      kind: 'unknown',
      description: locale === 'th' ? 'รูปจาก LINE' : 'Photo from LINE',
      party_hint: chat.party_id ? null : chat.display_name,
      photo_name: `line-${event.message.id}.jpg`,
      idem_key: `line:${event.message.id}`,
    })
    return {
      item,
      reply: locale === 'th' ? 'รับรูปแล้ว ขอบคุณค่ะ' : 'Got it, thank you.',
    }
  }

  if (event.message?.type !== 'text') return { reply: null }
  const intent = intentOf(event.message.text)

  if (intent === 'owed' && entityId && chat.party_id) {
    return { reply: await whatIsOwed(db, entityId, chat.party_id, { locale, origin }) }
  }
  if (intent === 'how_to_pay' && entityId && chat.party_id) {
    const docs = (await openDocs(db, entityId, { direction: 'out', asOf: today() }))
      .filter((d) => d.party_id === chat.party_id)
    if (!docs.length) return { reply: locale === 'th' ? 'ไม่มียอดค้างชำระ' : 'Nothing outstanding.' }
    return { reply: await howToPayText(db, docs[0].id, { locale, origin }) }
  }
  if (intent === 'claim' && entityId && chat.party_id) {
    const docs = (await openDocs(db, entityId, { direction: 'out', asOf: today() }))
      .filter((d) => d.party_id === chat.party_id)
    if (docs.length) {
      await claimPaid(db, {
        entity_id: entityId,
        doc_id: docs[0].id,
        amount: amountToAsk(docs[0]) - docs[0].paid - docs[0].wht_credited,
        method: 'transfer',
        note: 'said so on LINE',
        idem_key: `line:claim:${event.message.id}`,
      })
    }
    return {
      reply: locale === 'th'
        ? 'ขอบคุณค่ะ จะตรวจกับยอดเงินเข้าแล้วแจ้งกลับ'
        : 'Thank you — we will check it against the bank.',
    }
  }
  // The digest is for whoever keeps the books, not for a customer chat.
  if (intent === 'digest' && entityId && chat.person_id) {
    return { reply: await digest(db, entityId, { locale }) }
  }

  // Anything else is filed rather than answered: a message is data.
  if (entityId && event.message.text.length <= 200) {
    await receive(db, {
      entity_id: entityId,
      source: 'line',
      from_ref: chat.display_name || 'LINE',
      on_date: today(),
      kind: 'unknown',
      description: event.message.text.slice(0, 200),
      party_hint: chat.party_id ? null : chat.display_name,
      idem_key: `line:${event.message.id}`,
    })
  }
  return { reply: null }
}

const today = () => new Date().toISOString().slice(0, 10)
const addDays = (d, n) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
