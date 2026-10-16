// ids.mjs — identifiers, timestamps and the document numbering counter.
//
// Crypto comes off the global rather than from `node:crypto`, so the same file
// runs unchanged in Node, in a Worker and in a browser tab. Only the two
// primitives are used; a browser without them is old enough that nothing else
// here would work either.
const webCrypto = globalThis.crypto

export const uid = () => webCrypto.randomUUID()

export function token(bytes = 24) {
  const buf = new Uint8Array(bytes)
  webCrypto.getRandomValues(buf)
  let s = ''
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** ISO-8601 UTC with the trailing Z, so `new Date(stored)` re-parses as UTC. */
export const isoZ = (d = new Date()) =>
  (d instanceof Date ? d : new Date(d)).toISOString().replace(/\.\d{3}Z$/, 'Z')
export const nowZ = () => isoZ(new Date())

/** Slug that keeps Thai characters — a Thai-titled project should not slug
 *  down to its punctuation. */
export function slugify(s, fallback = 'x') {
  const base = String(s || '').trim().toLowerCase()
    .replace(/['"’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || fallback
}

const PREFIX = {
  journal: 'JV', invoice: 'INV', tax_invoice: 'TIV', receipt: 'REC',
  quote: 'QUO', bill: 'BIL', credit_note: 'CN', debit_note: 'DN',
  payment: 'PAY', payslip: 'PS', item: 'ITM',
}

/**
 * Next number in a per-entity, per-kind, per-year sequence: 'INV-2026-0042'.
 *
 * The sequence is gapless by construction because nothing here deletes: a
 * document that turns out wrong is voided and keeps its number, which is what
 * a tax officer expects to see when they read down the run.
 */
export async function nextNumber(db, entityId, kind, year) {
  const name = `${entityId}:${kind}:${year}`
  await db.run('INSERT INTO counter(name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING', name)
  await db.run('UPDATE counter SET value = value + 1 WHERE name = ?', name)
  const row = await db.get('SELECT value FROM counter WHERE name = ?', name)
  return `${PREFIX[kind] || 'DOC'}-${year}-${String(row.value).padStart(4, '0')}`
}
