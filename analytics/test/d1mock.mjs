// Minimal D1 binding backed by a real in-memory SQLite (node:sqlite), so the
// aggregation SQL in the Worker is executed for real — not faked. Implements
// exactly the surface the Worker uses: prepare().bind().run()/all()/first().
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8')

class Stmt {
  constructor(db, sql) { this._s = db.prepare(sql); this._args = [] }
  bind(...a) { this._args = a; return this }
  async run() { return this._s.run(...this._args) }
  async all() { return { results: this._s.all(...this._args) } }
  async first() { return this._s.get(...this._args) ?? null }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return {
    prepare: sql => new Stmt(db, sql),
    _raw: db,
    _insert(row) {
      db.prepare('INSERT INTO hits (ts,day,site,path,ref,country,device,vis) VALUES (?,?,?,?,?,?,?,?)')
        .run(row.ts, row.day, row.site, row.path, row.ref, row.country, row.device, row.vis)
    },
    _count() { return db.prepare('SELECT COUNT(*) c FROM hits').get().c },
    _rows() { return db.prepare('SELECT * FROM hits ORDER BY ts').all() },
  }
}

export function dayAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10)
}
export function tsAgo(n) { return Date.now() - n * 864e5 }
