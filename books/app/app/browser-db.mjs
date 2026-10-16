// browser-db.mjs — the same get/all/run/exec interface as the console's, over
// SQLite compiled to JavaScript.
//
// The point of the adapter: the demo runs the REAL modules. Nothing about
// invoicing, payroll or the filing calendar is reimplemented for the browser,
// so what this page does is what the books do.
//
// The database lives in the tab and is saved to the browser's own storage after
// every change. Nothing is sent anywhere — there is no server to send it to.

import { MIGRATIONS } from './schema.mjs'

/**
 * Where the books are saved in this browser.
 *
 * One page serves more than one country, and Phnom Penh's sample company is
 * not Chiang Mai's. The build is part of the key, so opening the Khmer demo
 * does not land in the middle of the Thai one.
 */
const BUILD = new URLSearchParams(location.search).has('kh') ? 'KH' : 'TH'
const KEY = `erp.demo.db.v1.${BUILD}`
export const BUILD_COUNTRY = BUILD

let saveTimer = null
let paused = 0

function bytesToBase64(bytes) {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

function base64ToBytes(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** Wrap a sql.js Database in the interface every module expects. */
export function sqlJsDb(database, { onChange = () => {} } = {}) {
  // Compiling a statement costs more than running it, and building the sample
  // company runs six thousand of them — the same two hundred texts over and
  // over. They are compiled once and kept by their text, which is most of the
  // difference between a page that opens and one somebody gives up on.
  const compiled = new Map()

  const take = (sql) => {
    const seen = compiled.get(sql)
    if (seen) { seen.reset(); return seen }
    const made = database.prepare(sql)
    compiled.set(sql, made)
    return made
  }

  // Anything that changes the shape of the database invalidates what was
  // compiled against the old shape, so the kept statements are thrown away
  // rather than reused against a table that has been rebuilt underneath them.
  const forget = () => {
    for (const st of compiled.values()) { try { st.free() } catch { /* already gone */ } }
    compiled.clear()
  }
  // Taking a copy of the file frees every statement the database is holding,
  // so the kept ones have to be let go with it — otherwise the next write uses
  // a closed statement, which is how saving broke the page rather than the
  // arithmetic. The saver calls this before it exports.
  database.__forget = forget
  const changesShape = (sql) => /^\s*(CREATE|DROP|ALTER|PRAGMA|VACUUM)\b/i.test(sql)

  // Anything else that exports the file — the button that takes a copy away —
  // closes the statements too, and it has no reason to know this cache exists.
  // So a closed statement is not an error: it is compiled again and retried.
  const closed = (err) => String(err && err.message ? err.message : err).includes('Statement closed')

  const readOnce = (sql, params) => {
    const stmt = take(sql)
    try {
      if (params.length) stmt.bind(params)
      const out = []
      while (stmt.step()) out.push(stmt.getAsObject())
      return out
    } finally {
      stmt.reset()
    }
  }

  const rowsFrom = (sql, params) => {
    try {
      return readOnce(sql, params)
    } catch (err) {
      if (!closed(err)) throw err
      forget()
      return readOnce(sql, params)
    }
  }
  return {
    kind: 'sqljs',
    async get(sql, ...params) {
      return rowsFrom(sql, params)[0] ?? null
    },
    async all(sql, ...params) {
      return rowsFrom(sql, params)
    },
    async run(sql, ...params) {
      if (changesShape(sql)) {
        forget()
        database.run(sql, params)
      } else {
        const write = () => {
          const stmt = take(sql)
          try {
            if (params.length) stmt.bind(params)
            stmt.step()
          } finally {
            stmt.reset()
          }
        }
        try {
          write()
        } catch (err) {
          if (!closed(err)) throw err
          forget()
          write()
        }
      }
      onChange()
      return { changes: database.getRowsModified(), lastRowId: null }
    },
    async exec(sql) {
      forget()
      database.exec(sql)
      onChange()
    },
    _raw: database,
  }
}

async function loadSqlJs() {
  // The vendored build defines initSqlJs on the page; it carries its own
  // memory rather than fetching a .wasm file, so the demo opens from a plain
  // static host with no extra content type to configure.
  if (!globalThis.initSqlJs) throw new Error('sql-asm.js did not load')
  return globalThis.initSqlJs()
}

export async function openBooks({ fresh = false } = {}) {
  const SQL = await loadSqlJs()
  const saved = fresh ? null : localStorage.getItem(KEY)
  const database = saved ? new SQL.Database(base64ToBytes(saved)) : new SQL.Database()
  database.run('PRAGMA foreign_keys = ON')

  const db = sqlJsDb(database, { onChange: () => scheduleSave(database) })
  await migrate(db)
  return { db, database, save: () => save(database), wipe }
}

async function migrate(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`)
  const applied = new Set((await db.all('SELECT name FROM schema_migration')).map((r) => r.name))
  for (const [name, step] of MIGRATIONS) {
    if (applied.has(name)) continue
    if (typeof step === 'string') await db.exec(step)
    else await step.up(db)
    await db.run('INSERT INTO schema_migration(name) VALUES (?)', name)
  }
}

function scheduleSave(database) {
  // Seeding writes thousands of rows, and exporting the whole file after each
  // one turns a fast build into a slow one. Saving is suspended while a batch
  // runs and happens once at the end.
  if (paused) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => save(database), 250)
}

/** Run a batch of writes with one save at the end. */
export async function inBatch(database, work) {
  paused++
  try {
    return await work()
  } finally {
    paused--
    if (!paused) save(database)
  }
}

export function save(database) {
  try {
    database.__forget?.()
    localStorage.setItem(KEY, bytesToBase64(database.export()))
    return true
  } catch (err) {
    // A full or blocked storage area is survivable: the tab keeps working and
    // what is on screen stays correct until it is closed.
    console.warn('not saved:', err.message)
    return false
  }
}

export function wipe() {
  localStorage.removeItem(KEY)
}

export const hasSaved = () => localStorage.getItem(KEY) != null
