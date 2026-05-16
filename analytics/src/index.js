// First-party, cookieless analytics. One Worker + one D1.
//   POST /e   collect a pageview (called by the beacon)
//   GET  /q   query aggregates (token-gated, called by the numbers dashboard)
//   cron      prune raw hits older than 90 days
//
// Privacy: no cookies, no stored IP. The visitor id is a daily-rotating hash
// of (day|site|ip|ua) — it cannot be correlated across days or back to a
// person. This is the Plausible-style model.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
}
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...CORS } })

export function host(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' }
}
export function device(ua = '') {
  if (/\bTablet\b|\biPad\b/i.test(ua)) return 'tablet'
  if (/Mobi|Android.+Mobile|iPhone|iPod/i.test(ua)) return 'mobile'
  return 'desktop'
}
export function isBot(ua = '') {
  return /bot|crawl|spider|preview|HeadlessChrome|Lighthouse|monitor|curl|wget|python-requests|axios|node-fetch/i.test(ua)
}
export async function visHash(day, site, ip, ua) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${site}|${ip}|${ua}`))
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function collect(req, env) {
  let d
  try { d = await req.json() } catch { return new Response(null, { status: 204, headers: CORS }) }
  // Trust the browser-set Origin first — page JS cannot forge a cross-origin
  // Origin on sendBeacon, so this prevents one site spoofing another's stats.
  // Fall back to the claimed `s` only when Origin is absent.
  const site = host(req.headers.get('origin') || '') || host(d.s ? `https://${d.s}` : '') || 'unknown'
  let path = String(d.p || '/').slice(0, 512)
  if (!path.startsWith('/')) path = '/' + path
  const ua = req.headers.get('user-agent') || ''
  if (isBot(ua)) return new Response(null, { status: 204, headers: CORS })
  const ip = req.headers.get('cf-connecting-ip') || ''
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  let ref = host(d.r || '')
  ref = !ref || ref === site ? 'direct' : ref
  const country = (req.cf && req.cf.country) || 'XX'
  const vis = await visHash(day, site, ip, ua)
  await env.DB.prepare(
    'INSERT INTO hits (ts,day,site,path,ref,country,device,vis) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(now, day, site, path, ref, country, device(ua), vis).run()
  return new Response(null, { status: 204, headers: CORS })
}

async function query(url, env) {
  if (url.searchParams.get('token') !== env.QUERY_TOKEN) return json({ error: 'unauthorized' }, 401)
  const site = url.searchParams.get('site') || null
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '28', 10)))
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const d7 = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)

  if (!site) {
    // Per-site rollup for the overview list. ? order: d7, d7, since
    const rows = (await env.DB.prepare(
      `SELECT site,
        SUM(CASE WHEN day>=? THEN 1 ELSE 0 END) AS pv7,
        COUNT(*) AS pv28,
        COUNT(DISTINCT CASE WHEN day>=? THEN vis END) AS v7,
        COUNT(DISTINCT vis) AS v28
       FROM hits WHERE day >= ? GROUP BY site ORDER BY pv28 DESC`
    ).bind(d7, d7, since).all()).results
    return json({ days, since, sites: rows })
  }

  const W = 'site = ? AND day >= ?'   // bind(site, since)
  const [series, totals, pages, refs, countries, devices] = await Promise.all([
    env.DB.prepare(`SELECT day, COUNT(*) pv, COUNT(DISTINCT vis) v FROM hits WHERE ${W} GROUP BY day ORDER BY day`).bind(site, since).all(),
    env.DB.prepare(
      `SELECT COUNT(*) pv28, COUNT(DISTINCT vis) v28,
        SUM(CASE WHEN day>=? THEN 1 ELSE 0 END) pv7,
        COUNT(DISTINCT CASE WHEN day>=? THEN vis END) v7
       FROM hits WHERE ${W}`).bind(d7, d7, site, since).first(),
    env.DB.prepare(`SELECT path, COUNT(*) pv FROM hits WHERE ${W} GROUP BY path ORDER BY pv DESC LIMIT 15`).bind(site, since).all(),
    env.DB.prepare(`SELECT ref, COUNT(*) pv FROM hits WHERE ${W} GROUP BY ref ORDER BY pv DESC LIMIT 10`).bind(site, since).all(),
    env.DB.prepare(`SELECT country, COUNT(*) pv FROM hits WHERE ${W} GROUP BY country ORDER BY pv DESC LIMIT 10`).bind(site, since).all(),
    env.DB.prepare(`SELECT device, COUNT(*) pv FROM hits WHERE ${W} GROUP BY device ORDER BY pv DESC`).bind(site, since).all(),
  ])
  return json({
    site, days, since,
    totals,
    series: series.results,
    topPages: pages.results,
    topReferrers: refs.results,
    topCountries: countries.results,
    devices: devices.results,
  })
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    try {
      if (req.method === 'POST' && url.pathname === '/e') return await collect(req, env)
      if (req.method === 'GET' && url.pathname === '/q') return await query(url, env)
      if (url.pathname === '/') return new Response('ok', { status: 200, headers: CORS })
    } catch (e) {
      console.error('worker error:', e && e.stack || e)
      return json({ error: 'internal error' }, 500)
    }
    return new Response('not found', { status: 404, headers: CORS })
  },
  async scheduled(_e, env) {
    const cut = Date.now() - 90 * 864e5
    await env.DB.prepare('DELETE FROM hits WHERE ts < ?').bind(cut).run()
  },
}
