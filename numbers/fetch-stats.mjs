#!/usr/bin/env node
// Pull cross-project traffic from Cloudflare Web Analytics (one account-wide
// GraphQL query covers every site) and write numbers/public/data.json for the
// HusbandLabs monitor dashboard.
//
// Web metrics: 7-day + 28-day trailing pageviews per host, plus top pages
// (28d) for hosts above a traffic floor.
//
// App metrics: App Store Connect (placeholder until the apps have install
// data — they're brand new / in TestFlight). The dashboard renders an
// "awaiting data" state for those.
//
// Auth: CLOUDFLARE_API_TOKEN from the shell env (~/.zshrc → keys.env).
//
// Run: node numbers/fetch-stats.mjs

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ACCOUNT = '4219a576830c72b0e6e4ca358e61473a'
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
if (!TOKEN) { console.error('CLOUDFLARE_API_TOKEN not set'); process.exit(1) }

// A host is "staging" if its left-most label is literally "staging", or it's
// a *.pages.dev preview. EPHEMERAL previews (left label is all hex/digits,
// e.g. 1a2b3c4d.staging.purecalculators.dev or 33521e25.husbandlabs.pages.dev)
// are dropped entirely — they're throwaway.
function classifyHost(host) {
  const labels = host.split('.')
  const first = labels[0]
  const ephemeral = /^[0-9a-f]{6,}$/i.test(first) || /^[0-9]+$/.test(first)
  if (host.endsWith('.pages.dev')) return ephemeral ? 'drop' : 'staging'
  if (first === 'staging') return 'staging'
  if (labels.includes('staging')) return ephemeral ? 'drop' : 'staging'
  return 'live'
}

// Client projects — this dashboard is personal-only. Any host matching one of
// these substrings is dropped entirely (totals, sites, staging, top pages).
const CLIENT_EXCLUDE = [
  'hellocake',
  'studio680', 'studio-680',
  'makingamark', 'making-a-mark',
  'stevenbrown', 'stevenbrownford', 'brownforaustin'
]
function isClientHost(host) {
  const h = host.toLowerCase()
  return CLIENT_EXCLUDE.some(s => h.includes(s))
}

// Curated staging URLs to always list (even with zero analytics traffic), so
// they're one click away. Add as projects gain staging envs.
const STAGING_LINKS = [
  { label: 'PureCalculators · staging', url: 'https://staging.purecalculators.com/' },
  { label: 'PureCalculators · staging dashboard', url: 'https://staging.purecalculators.com/dashboard/' }
]

// The PureCalculators cluster gets a wide featured panel: the website plus its
// companion iOS app (Steps-to-km is a native port of the steps-to-km calc).
const APPS = [
  { name: 'Steps to km · Miles', cluster: 'purecalculators', bundle: 'com.eastbayprojects.steps', sku: 'STEPS', status: 'in development' },
  { name: 'What Does the Cow Say', cluster: 'standalone', bundle: 'easybayprojects.littlebob', sku: 'whatdoesthecowsay', status: 'live on App Store' }
]

function isoDaysAgo(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10) }

// ── First-party analytics (real, coherent — replaces CF zone/RUM) ──────────
const FP_URL = process.env.ANALYTICS_URL
const FP_TOKEN = process.env.ANALYTICS_TOKEN
async function fpOverview() {
  if (!FP_URL || !FP_TOKEN) return {}
  try {
    const r = await fetch(`${FP_URL}/q?token=${encodeURIComponent(FP_TOKEN)}&days=28`)
    const j = await r.json()
    return Object.fromEntries((j.sites || []).map(s => [s.site, s]))
  } catch (e) { console.warn('first-party overview unavailable:', e.message); return {} }
}
async function fpSite(host) {
  if (!FP_URL || !FP_TOKEN) return null
  try {
    const r = await fetch(`${FP_URL}/q?token=${encodeURIComponent(FP_TOKEN)}&site=${encodeURIComponent(host)}&days=28`)
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function gql(query, variables) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables })
  })
  const j = await res.json()
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors))
  return j
}

// ── Zone-level analytics (true 28-day per-day data) ────────────────────────
// Needs a token with Zone Analytics:Read. The default nate-bot token doesn't
// have it, so this path may 403 — caller falls back to RUM and flags it.
const ANALYTICS_TOKEN = process.env.CF_ANALYTICS_TOKEN || TOKEN

async function listZones() {
  const out = []
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`,
      { headers: { authorization: `Bearer ${ANALYTICS_TOKEN}` } })
    const j = await r.json()
    if (!j.success) throw new Error('zones: ' + JSON.stringify(j.errors))
    out.push(...j.result.map(z => ({ tag: z.id, name: z.name })))
    if (j.result.length < 50) break
  }
  return out
}

async function zoneDaily(zoneTag, days) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ANALYTICS_TOKEN}` },
    body: JSON.stringify({
      query: `query($z:String!,$s:Date!,$e:Date!){viewer{zones(filter:{zoneTag:$z}){
        httpRequests1dGroups(limit:40,filter:{date_geq:$s,date_leq:$e},orderBy:[date_ASC]){
          dimensions{date} sum{pageViews} }}}}`,
      variables: { z: zoneTag, s: isoDaysAgo(days), e: isoDaysAgo(0) }
    })
  })
  const j = await r.json()
  if (j.errors) { const e = new Error(JSON.stringify(j.errors)); e.code = 'gql'; throw e }
  return j.data?.viewer?.zones?.[0]?.httpRequests1dGroups || []
}

async function pageviewsByHost(days) {
  const j = await gql(
    `query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
       rumPageloadEventsAdaptiveGroups(limit:500,filter:{date_geq:$s,date_leq:$e},orderBy:[count_DESC]){
         count dimensions{requestHost}}}}}`,
    { a: ACCOUNT, s: isoDaysAgo(days), e: isoDaysAgo(0) }
  )
  const g = j.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || []
  const byHost = {}
  for (const x of g) {
    const h = (x.dimensions.requestHost || '').replace(/^www\./, '')
    if (!h) continue
    byHost[h] = (byHost[h] || 0) + x.count
  }
  return byHost
}

async function topPagesForHost(host, days, limit = 12) {
  // requestHost filter matches exact host; we also accept the www. variant by
  // querying the bare host (CF stores the host as sent, so query both).
  const j = await gql(
    `query($a:String!,$s:Date!,$e:Date!,$h:string!){viewer{accounts(filter:{accountTag:$a}){
       rumPageloadEventsAdaptiveGroups(limit:200,filter:{date_geq:$s,date_leq:$e,requestHost:$h},orderBy:[count_DESC]){
         count dimensions{requestPath}}}}}`,
    { a: ACCOUNT, s: isoDaysAgo(days), e: isoDaysAgo(0), h: host }
  )
  const g = j.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || []
  const byPath = {}
  for (const x of g) {
    const p = x.dimensions.requestPath || '/'
    if (/\.(js|css|png|jpe?g|webp|svg|ico|woff2?|map|txt|xml|json)$/.test(p)) continue
    byPath[p] = (byPath[p] || 0) + x.count
  }
  return Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([path, pv]) => ({ path, pv }))
}

async function main() {
  // Try true zone-level daily analytics first (reliable 28d). Falls back to
  // the free RUM dataset (which the API caps to ~1 recent day) if the token
  // lacks Zone Analytics:Read.
  let dataQuality = 'zone-daily'
  let pv7 = {}, pv28 = {}
  try {
    console.log('Trying zone-level analytics (true 28d)…')
    const zones = await listZones()
    for (const z of zones) {
      let rows
      try { rows = await zoneDaily(z.tag, 28) } catch (e) {
        if (String(e.message).includes('analytics.read')) throw e   // perms → bail to fallback
        continue                                                    // a single bad zone → skip
      }
      let v7 = 0, v28 = 0
      const n = rows.length
      rows.forEach((r, i) => {
        const ago = n - 1 - i
        v28 += r.sum.pageViews
        if (ago < 7) v7 += r.sum.pageViews
      })
      if (v28 > 0) { pv28[z.name] = v28; pv7[z.name] = v7 }
    }
    if (Object.keys(pv28).length === 0) throw new Error('zone analytics returned nothing')
    console.log(`  zone-level OK — ${Object.keys(pv28).length} zones with traffic`)
  } catch (e) {
    console.warn('  zone analytics unavailable (' + (e.code === 'gql' ? 'no Analytics:Read scope' : e.message) + ') → RUM fallback')
    dataQuality = 'cf-rum-limited'   // 7d≈28d because free RUM API caps the window
    ;[pv7, pv28] = await Promise.all([pageviewsByHost(7), pageviewsByHost(28)])
  }

  const hosts = [...new Set([...Object.keys(pv7), ...Object.keys(pv28)])]
  const live = []
  const staging = []
  for (const h of hosts) {
    const v28 = pv28[h] || 0
    const v7 = pv7[h] || 0
    if (v28 === 0 && v7 === 0) continue
    if (isClientHost(h)) continue
    const kind = classifyHost(h)
    if (kind === 'drop') continue
    if (kind === 'staging') { staging.push({ host: h }); continue }  // links only — no fake CF pv
    // top pages for every live site — no threshold (RUM only; zone API has no path dim on free)
    let topPages = []
    try { topPages = await topPagesForHost(h, 28) } catch {}
    if (topPages.length === 0) { try { topPages = await topPagesForHost('www.' + h, 28) } catch {} }
    live.push({ host: h, pv7: v7, pv28: v28, topPages })
  }
  // Override CF estimates with real first-party numbers where the beacon is
  // live. Sites without first-party data keep the (degraded) CF figures and
  // are flagged so the UI can show them as estimates.
  // Only first-party data is trustworthy. The Cloudflare zone/RUM numbers are
  // sampled/clamped garbage (7d≈28d, page counts in multiples of 10), so for
  // any site without the beacon we show N/A — never a fabricated estimate.
  const fp = await fpOverview()
  let anyFP = false
  for (const s of live) {
    const f = fp[s.host]
    if (f && f.pv28 > 0) {
      s.pv7 = f.pv7; s.pv28 = f.pv28
      s.visitors7 = f.v7; s.visitors28 = f.v28
      s.src = 'first-party'; anyFP = true
    } else {
      s.src = 'no-data'
      s.pv7 = null; s.pv28 = null
      s.visitors7 = null; s.visitors28 = null
      s.topPages = []
    }
  }
  if (anyFP) dataQuality = 'first-party'

  const byPv = (a, b) => (b.pv28 ?? -1) - (a.pv28 ?? -1)
  live.sort(byPv)
  staging.sort(byPv)

  // App Store Connect metrics (best-effort — never block the dashboard)
  let appData = APPS.map(a => ({ ...a, installs7: null, installs28: null }))
  try {
    const { getAppMetrics } = await import('./asc.mjs')
    const m = await getAppMetrics({ vendorNumber: process.env.ASC_VENDOR_NUMBER })
    const bySku = Object.fromEntries(m.apps.map(x => [x.sku, x]))
    appData = APPS.map(a => {
      const live = bySku[a.sku]
      return {
        ...a,
        appStoreId: live?.id || null,
        installs7: live?.installs7 ?? null,
        installs28: live?.installs28 ?? null,
        listed: !!live
      }
    })
  } catch (e) { console.warn('ASC fetch skipped:', e.message) }

  // Pull the PureCalculators website out as the featured cluster
  const pcIdx = live.findIndex(s => s.host === 'purecalculators.com')
  const pcSite = pcIdx >= 0 ? live.splice(pcIdx, 1)[0] : null

  // Rich first-party breakdown for the featured panel (who the users are)
  let pcDetail = null
  if (pcSite) {
    const d = await fpSite('purecalculators.com')
    if (d && d.totals && d.totals.pv28 > 0) {
      pcDetail = {
        topPages: d.topPages, topReferrers: d.topReferrers,
        topCountries: d.topCountries, devices: d.devices, series: d.series
      }
      pcSite.topPages = d.topPages.map(p => ({ path: p.path, pv: p.pv }))
      pcSite.visitors7 = d.totals.v7; pcSite.visitors28 = d.totals.v28
      pcSite.pv7 = d.totals.pv7; pcSite.pv28 = d.totals.pv28
      pcSite.src = 'first-party'
    }
  }

  const out = {
    generated: new Date().toISOString(),
    window: { short: '7d', long: '28d' },
    dataQuality,   // 'zone-daily' = real | 'cf-rum-limited' = 7d≈28d, needs Analytics:Read token
    totals: {
      pv7: [pcSite, ...live].filter(Boolean).reduce((a, s) => a + (s.pv7 || 0), 0),
      pv28: [pcSite, ...live].filter(Boolean).reduce((a, s) => a + (s.pv28 || 0), 0),
      visitors28: [pcSite, ...live].filter(Boolean).reduce((a, s) => a + (s.visitors28 || 0), 0),
      siteCount: live.length + (pcSite ? 1 : 0)
    },
    purecalculators: {
      site: pcSite,
      detail: pcDetail,
      apps: appData.filter(a => a.cluster === 'purecalculators')
    },
    sites: live,
    apps: appData.filter(a => a.cluster !== 'purecalculators'),
    staging,
    stagingLinks: STAGING_LINKS
  }
  await fs.writeFile(path.join(__dirname, 'public/data.json'), JSON.stringify(out, null, 2) + '\n')
  console.log(`Wrote public/data.json — ${out.totals.siteCount} live sites, ${staging.length} staging, ${out.totals.pv28} pv (28d)`)
  if (pcSite) console.log(`  ★ purecalculators.com  ${pcSite.pv28} 28d / ${pcSite.pv7} 7d`)
  for (const s of live.slice(0, 8)) {
    console.log(`  ${String(s.pv28).padStart(6)} 28d / ${String(s.pv7).padStart(5)} 7d   ${s.host}`)
  }
  console.log(`  apps: ${appData.map(a => a.name + (a.listed ? ' (listed)' : '')).join(', ')}`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
