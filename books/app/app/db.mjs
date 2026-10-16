// db.mjs — one async query interface satisfied by BOTH runtimes:
//   • node:sqlite (DatabaseSync) for local dev + the test suite
//   • Cloudflare D1 in production
// D1 is async and node:sqlite is sync, so the interface is async everywhere.
// Application code only ever touches this shape — get / all / run — never a raw
// driver, so the whole system is testable without a Worker and the board demo
// needs no Cloudflare account.

/** Adapter over Node's built-in node:sqlite (no native dependency). */
export function nodeDb(database) {
  return {
    kind: 'node',
    async get(sql, ...params) {
      return database.prepare(sql).get(...params) ?? null
    },
    async all(sql, ...params) {
      return database.prepare(sql).all(...params)
    },
    async run(sql, ...params) {
      const r = database.prepare(sql).run(...params)
      return { changes: r.changes, lastRowId: r.lastInsertRowid }
    },
    async exec(sql) {
      database.exec(sql)
    },
    _raw: database,
  }
}

/** Adapter over a Cloudflare D1 binding (env.DB). */
export function d1Db(binding) {
  return {
    kind: 'd1',
    async get(sql, ...params) {
      return (await binding.prepare(sql).bind(...params).first()) ?? null
    },
    async all(sql, ...params) {
      const r = await binding.prepare(sql).bind(...params).all()
      return r.results ?? []
    },
    async run(sql, ...params) {
      const r = await binding.prepare(sql).bind(...params).run()
      return { changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? null }
    },
    async exec(sql) {
      await binding.exec(sql)
    },
  }
}
