// 0017_margin_basis.mjs — let an agreement be a net price rather than a rate.
//
// SQLite will not widen a CHECK in place, so the table is rebuilt. The lesson
// from the first attempt is in the code: the column list is READ FROM THE
// TABLE rather than written out, because a second set of migrations had added
// a Khmer name column and a hand-written list dropped it.
//
// Anything this repo adds to `referral_agreement` later comes through the same
// rebuild untouched.

const WIDENED = `CREATE TABLE referral_agreement_new (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  party_id      TEXT NOT NULL REFERENCES party(id),
  code          TEXT NOT NULL,
  name_en       TEXT NOT NULL,
  name_th       TEXT,
  basis         TEXT NOT NULL DEFAULT 'percent_of_fee'
                CHECK (basis IN ('percent_of_fee','fixed_per_case','tiered','margin')),
  rate_bp       INTEGER,
  fixed_amount  INTEGER,
  tiers         TEXT,
  currency      TEXT NOT NULL DEFAULT 'THB',
  wht_bp        INTEGER NOT NULL DEFAULT 300,
  project_id    TEXT REFERENCES project(id),
  account_code  TEXT NOT NULL DEFAULT '4900',
  terms_days    INTEGER NOT NULL DEFAULT 15,
  from_date     TEXT NOT NULL,
  to_date       TEXT,
  source        TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`

/** The columns named in the definition above, in its order. */
const KNOWN = [
  'id', 'entity_id', 'party_id', 'code', 'name_en', 'name_th', 'basis', 'rate_bp',
  'fixed_amount', 'tiers', 'currency', 'wht_bp', 'project_id', 'account_code',
  'terms_days', 'from_date', 'to_date', 'source', 'note', 'created_at',
]

export async function up(db) {
  const columns = (await db.all('PRAGMA table_info(referral_agreement)')).map((c) => c.name)
  if (!columns.length) return                      // nothing to rebuild yet

  await db.exec(WIDENED)
  // Everything the old table had that the new definition also has.
  const shared = KNOWN.filter((c) => columns.includes(c))
  await db.run(
    `INSERT INTO referral_agreement_new(${shared.join(', ')})
       SELECT ${shared.join(', ')} FROM referral_agreement`)
  await db.exec('DROP TABLE referral_agreement')
  await db.exec('ALTER TABLE referral_agreement_new RENAME TO referral_agreement')
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_agreement_live ON referral_agreement(entity_id, code, from_date)')

  // Columns another migration added and this rebuild does not know about are
  // put back, so a second set of books keeps its own language.
  for (const extra of columns.filter((c) => !KNOWN.includes(c))) {
    await db.run(`ALTER TABLE referral_agreement ADD COLUMN ${extra} TEXT`)
  }
  // The Khmer name the earlier rebuild dropped.
  const after = (await db.all('PRAGMA table_info(referral_agreement)')).map((c) => c.name)
  if (!after.includes('name_km')) {
    await db.run('ALTER TABLE referral_agreement ADD COLUMN name_km TEXT')
  }
}
