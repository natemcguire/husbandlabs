import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { host, device, isBot, visHash } from '../src/index.js'
import { makeD1, dayAgo, tsAgo } from './d1mock.mjs'

const ENV = db => ({ DB: db, QUERY_TOKEN: 'secret' })

// Lightweight Cloudflare-style request (the real Request has no `.cf`).
function req(method, url, { body, headers = {}, cf } = {}) {
  return {
    method,
    url,
    cf,
    headers: new Headers(headers),
    async json() { if (body === undefined) throw new Error('no body'); return body },
  }
}
const post = (body, headers, cf) =>
  req('POST', 'https://w.dev/e', { body, headers, cf })

// ── pure helpers ──────────────────────────────────────────────────────────
test('host strips www, lowercases, tolerates junk', () => {
  assert.equal(host('https://www.Example.com/x'), 'example.com')
  assert.equal(host('https://a.b.co'), 'a.b.co')
  assert.equal(host('not a url'), '')
  assert.equal(host(''), '')
})

test('device classification', () => {
  assert.equal(device('Mozilla/5.0 (iPhone; CPU iPhone OS) Mobile/15E'), 'mobile')
  assert.equal(device('Mozilla/5.0 (iPad; CPU OS) Safari'), 'tablet')
  assert.equal(device('Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome'), 'desktop')
  assert.equal(device(''), 'desktop')
})

test('isBot catches crawlers and tooling, not real browsers', () => {
  for (const ua of ['Googlebot/2.1', 'curl/8.1', 'python-requests/2', 'node-fetch', 'HeadlessChrome'])
    assert.equal(isBot(ua), true, ua)
  assert.equal(isBot('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari'), false)
})

test('visHash is deterministic and rotates daily (privacy)', async () => {
  const a = await visHash('2026-05-16', 'x.com', '1.2.3.4', 'UA')
  const b = await visHash('2026-05-16', 'x.com', '1.2.3.4', 'UA')
  const next = await visHash('2026-05-17', 'x.com', '1.2.3.4', 'UA')
  const other = await visHash('2026-05-16', 'x.com', '9.9.9.9', 'UA')
  assert.equal(a, b)
  assert.notEqual(a, next, 'must differ across days — uncorrelatable')
  assert.notEqual(a, other)
  assert.match(a, /^[0-9a-f]{16}$/)
})

// ── collect ───────────────────────────────────────────────────────────────
test('collect inserts one well-formed row', async () => {
  const db = makeD1()
  const r = await worker.fetch(
    post({ s: 'purecalculators.com', p: '/love-calculator/', r: 'https://www.google.com/q' },
      { origin: 'https://purecalculators.com', 'user-agent': 'Mozilla/5.0 iPhone Mobile' },
      { country: 'DE' }), ENV(db))
  assert.equal(r.status, 204)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  const rows = db._rows()
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.site, 'purecalculators.com')
  assert.equal(row.path, '/love-calculator/')
  assert.equal(row.ref, 'google.com')
  assert.equal(row.country, 'DE')
  assert.equal(row.device, 'mobile')
  assert.equal(row.day, dayAgo(0))
  assert.match(row.vis, /^[0-9a-f]{16}$/)
})

test('SECURITY: browser Origin overrides a spoofed site claim', async () => {
  const db = makeD1()
  await worker.fetch(
    post({ s: 'victim-site.com', p: '/' },
      { origin: 'https://attacker.example' }), ENV(db))
  assert.equal(db._rows()[0].site, 'attacker.example',
    'must record the real Origin, not the attacker-controlled payload field')
})

test('collect falls back to claimed site only when Origin absent', async () => {
  const db = makeD1()
  await worker.fetch(post({ s: 'real.com', p: '/a' }), ENV(db))
  assert.equal(db._rows()[0].site, 'real.com')
})

test('collect: same-origin referrer becomes "direct"', async () => {
  const db = makeD1()
  await worker.fetch(post({ s: 'x.com', p: '/', r: 'https://x.com/prev' },
    { origin: 'https://x.com' }), ENV(db))
  assert.equal(db._rows()[0].ref, 'direct')
})

test('collect: missing referrer becomes "direct"', async () => {
  const db = makeD1()
  await worker.fetch(post({ s: 'x.com', p: '/' }, { origin: 'https://x.com' }), ENV(db))
  assert.equal(db._rows()[0].ref, 'direct')
})

test('collect: path gets leading slash and is length-capped', async () => {
  const db = makeD1()
  await worker.fetch(post({ s: 'x.com', p: 'noslash' }, { origin: 'https://x.com' }), ENV(db))
  await worker.fetch(post({ s: 'x.com', p: '/' + 'a'.repeat(900) }, { origin: 'https://x.com' }), ENV(db))
  const rows = db._rows()
  assert.equal(rows[0].path, '/noslash')
  assert.ok(rows[1].path.length <= 512)
})

test('collect: bots are dropped (204, no row)', async () => {
  const db = makeD1()
  const r = await worker.fetch(post({ s: 'x.com', p: '/' },
    { origin: 'https://x.com', 'user-agent': 'Googlebot/2.1' }), ENV(db))
  assert.equal(r.status, 204)
  assert.equal(db._count(), 0)
})

test('collect: malformed body is swallowed (204, no row, no throw)', async () => {
  const db = makeD1()
  const r = await worker.fetch(req('POST', 'https://w.dev/e', {}), ENV(db))
  assert.equal(r.status, 204)
  assert.equal(db._count(), 0)
})

// ── query ─────────────────────────────────────────────────────────────────
function seed(db) {
  // x.com: 3 hits today (2 visitors), 1 hit 10d ago, 1 hit 100d ago (out of 90d)
  for (const v of ['v1', 'v1', 'v2'])
    db._insert({ ts: tsAgo(0), day: dayAgo(0), site: 'x.com', path: '/', ref: 'google.com', country: 'US', device: 'desktop', vis: v })
  db._insert({ ts: tsAgo(10), day: dayAgo(10), site: 'x.com', path: '/about', ref: 'direct', country: 'GB', device: 'mobile', vis: 'v3' })
  db._insert({ ts: tsAgo(100), day: dayAgo(100), site: 'x.com', path: '/old', ref: 'direct', country: 'US', device: 'desktop', vis: 'v4' })
  // y.com: 1 hit 3d ago
  db._insert({ ts: tsAgo(3), day: dayAgo(3), site: 'y.com', path: '/', ref: 'direct', country: 'FR', device: 'tablet', vis: 'v9' })
}
const q = (db, qs) => worker.fetch(req('GET', 'https://w.dev/q?' + qs), ENV(db))

test('query: rejects missing/bad token with 401', async () => {
  const db = makeD1(); seed(db)
  assert.equal((await q(db, 'site=x.com')).status, 401)
  assert.equal((await q(db, 'token=wrong&site=x.com')).status, 401)
})

test('query overview: correct per-site 7d/28d pv + visitors', async () => {
  const db = makeD1(); seed(db)
  const j = await (await q(db, 'token=secret&days=28')).json()
  const x = j.sites.find(s => s.site === 'x.com')
  assert.equal(x.pv7, 3, '3 hits today within 7d (100d-old excluded)')
  assert.equal(x.pv28, 4, 'today x3 + 10d-ago x1 within 28d; 100d excluded')
  assert.equal(x.v7, 2, 'distinct visitors last 7d: v1,v2')
  assert.equal(x.v28, 3, 'distinct visitors last 28d: v1,v2,v3')
  assert.equal(j.sites.find(s => s.site === 'y.com').pv28, 1)
})

test('query per-site: totals, series, breakdowns are correct', async () => {
  const db = makeD1(); seed(db)
  const j = await (await q(db, 'token=secret&site=x.com&days=28')).json()
  assert.equal(j.totals.pv28, 4)
  assert.equal(j.totals.pv7, 3)
  assert.equal(j.totals.v28, 3)
  assert.equal(j.totals.v7, 2)
  assert.deepEqual(j.series.map(r => r.day).sort(), [dayAgo(10), dayAgo(0)].sort())
  const home = j.topPages.find(p => p.path === '/')
  assert.equal(home.pv, 3)
  assert.equal(home.v, 2, 'top pages must expose distinct visitors, not just hits')
  assert.equal(j.topReferrers.find(r => r.ref === 'google.com').pv, 3)
  assert.equal(j.topCountries.find(c => c.country === 'US').pv, 3)
  const desktop = j.devices.find(d => d.device === 'desktop')
  assert.equal(desktop.pv, 3)
})

test('query: days param is clamped to [1,90]', async () => {
  const db = makeD1(); seed(db)
  const big = await (await q(db, 'token=secret&site=x.com&days=9999')).json()
  assert.equal(big.days, 90)
  assert.equal(big.totals.pv28, 4, '100d-old row still excluded at max 90d window')
  const small = await (await q(db, 'token=secret&site=x.com&days=-5')).json()
  assert.equal(small.days, 1)
})

// ── scheduled prune ───────────────────────────────────────────────────────
test('scheduled prune deletes >90d rows, keeps the rest', async () => {
  const db = makeD1(); seed(db)
  assert.equal(db._count(), 6)
  await worker.scheduled({}, ENV(db))
  assert.equal(db._count(), 5, 'the single 100-day-old row is pruned')
})

// ── routing / errors ──────────────────────────────────────────────────────
test('routing: OPTIONS, health, 404', async () => {
  const db = makeD1()
  assert.equal((await worker.fetch(req('OPTIONS', 'https://w.dev/e'), ENV(db))).status, 204)
  const health = await worker.fetch(req('GET', 'https://w.dev/'), ENV(db))
  assert.equal(health.status, 200)
  assert.equal(await health.text(), 'ok')
  assert.equal((await worker.fetch(req('GET', 'https://w.dev/nope'), ENV(db))).status, 404)
})

test('internal errors return generic 500 (no message leak)', async () => {
  const badEnv = { QUERY_TOKEN: 'secret', DB: { prepare() { throw new Error('SECRET DB INTERNALS') } } }
  const r = await worker.fetch(post({ s: 'x.com', p: '/' }, { origin: 'https://x.com' }), badEnv)
  assert.equal(r.status, 500)
  const body = await r.json()
  assert.equal(body.error, 'internal error')
  assert.ok(!JSON.stringify(body).includes('SECRET DB INTERNALS'))
})
