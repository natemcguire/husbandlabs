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

const TOP_PAGES_FLOOR = 50   // only fetch top-pages for hosts with ≥ this many 28d views
const APPS = [
  // Brand-new iOS apps — no install data yet. Shown as "awaiting data".
  { name: 'Steps to km · Miles', slug: 'steps-to-km', bundle: 'com.eastbayprojects.steps', status: 'in development' },
  { name: "What Does the Cow Say", slug: 'cow-say', bundle: 'easybayprojects.littlebob', status: 'TestFlight beta' }
]

function isoDaysAgo(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10) }

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
  console.log('Fetching account-wide pageviews…')
  const [pv7, pv28] = await Promise.all([pageviewsByHost(7), pageviewsByHost(28)])

  const hosts = [...new Set([...Object.keys(pv7), ...Object.keys(pv28)])]
  const sites = []
  for (const h of hosts) {
    const v28 = pv28[h] || 0
    const v7 = pv7[h] || 0
    if (v28 === 0 && v7 === 0) continue
    let topPages = []
    if (v28 >= TOP_PAGES_FLOOR) {
      try { topPages = await topPagesForHost(h, 28) } catch (e) { /* host filter sometimes 0 — skip */ }
      // CF stores some hosts with www.; retry once with www. if empty
      if (topPages.length === 0) {
        try { topPages = await topPagesForHost('www.' + h, 28) } catch {}
      }
    }
    sites.push({ host: h, pv7: v7, pv28: v28, topPages })
  }
  sites.sort((a, b) => b.pv28 - a.pv28)

  const out = {
    generated: new Date().toISOString(),
    window: { short: '7d', long: '28d' },
    totals: {
      pv7: sites.reduce((a, s) => a + s.pv7, 0),
      pv28: sites.reduce((a, s) => a + s.pv28, 0),
      siteCount: sites.length
    },
    sites,
    apps: APPS.map(a => ({ ...a, metrics: null }))   // null = awaiting data
  }
  await fs.writeFile(path.join(__dirname, 'public/data.json'), JSON.stringify(out, null, 2) + '\n')
  console.log(`Wrote public/data.json — ${sites.length} sites, ${out.totals.pv28} pv (28d)`)
  console.log('Top 8:')
  for (const s of sites.slice(0, 8)) {
    console.log(`  ${String(s.pv28).padStart(6)} 28d / ${String(s.pv7).padStart(5)} 7d   ${s.host}`)
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
