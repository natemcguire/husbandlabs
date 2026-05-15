#!/usr/bin/env node
// App Store Connect client. Generates an ES256 JWT from the .p8 key and pulls
// real metrics for the live apps. Exported as getAppMetrics() so fetch-stats
// can fold app numbers into the dashboard data.
//
// Creds (from ~/.claude memory, shared across all iOS projects):
//   Key ID   7NX6CD6V94
//   Issuer   69a6de87-d7b3-47e3-e053-5b8c7c11a4d1
//   Key file ~/.appstoreconnect/AuthKey_7NX6CD6V94.p8
//
// Sales reports need a vendor number (filter[vendorNumber]); pass via
// ASC_VENDOR_NUMBER env or the --vendor flag. Without it we still return
// app metadata + App Store state (live / in review / etc).

import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const KEY_ID = '7NX6CD6V94'
const ISSUER = '69a6de87-d7b3-47e3-e053-5b8c7c11a4d1'
const KEY_PATH = path.join(os.homedir(), '.appstoreconnect/AuthKey_7NX6CD6V94.p8')

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeJwt() {
  const key = fs.readFileSync(KEY_PATH, 'utf8')
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' }
  const payload = { iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signer = crypto.createSign('SHA256')
  signer.update(signingInput)
  // ES256 needs the raw (r||s) signature, not DER — Node's dsaEncoding option:
  const sig = signer.sign({ key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${b64url(sig)}`
}

async function asc(pathAndQuery) {
  const jwt = makeJwt()
  const res = await fetch(`https://api.appstoreconnect.apple.com${pathAndQuery}`, {
    headers: { authorization: `Bearer ${jwt}` }
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`ASC ${res.status} ${pathAndQuery}: ${txt.slice(0, 300)}`)
  }
  return res.json()
}

// Sales report: returns a gzipped TSV. We parse the "Units" column summed over
// the report period for the given app's SKU.
async function salesUnits(vendorNumber, reportDate) {
  const jwt = makeJwt()
  const qs = new URLSearchParams({
    'filter[frequency]': 'DAILY',
    'filter[reportType]': 'SALES',
    'filter[reportSubType]': 'SUMMARY',
    'filter[vendorNumber]': vendorNumber,
    'filter[reportDate]': reportDate
  })
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${qs}`, {
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/a-gzip' }
  })
  if (res.status === 404) return null   // no report for that day yet
  if (!res.ok) throw new Error(`salesReports ${res.status}: ${(await res.text().catch(()=>'')).slice(0,200)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const tsv = zlib.gunzipSync(buf).toString('utf8')
  const lines = tsv.trim().split('\n')
  const header = lines[0].split('\t')
  const skuIdx = header.indexOf('SKU')
  const unitsIdx = header.indexOf('Units')
  const titleIdx = header.indexOf('Title')
  const bySku = {}
  for (const line of lines.slice(1)) {
    const c = line.split('\t')
    const sku = c[skuIdx]
    const units = parseInt(c[unitsIdx], 10) || 0
    bySku[sku] = bySku[sku] || { units: 0, title: c[titleIdx] }
    bySku[sku].units += units
  }
  return bySku
}

export async function getAppMetrics({ vendorNumber } = {}) {
  // 1. List apps (metadata + App Store state)
  const apps = await asc('/v1/apps?limit=50&fields[apps]=name,bundleId,sku')
  const out = []
  for (const a of apps.data || []) {
    out.push({
      id: a.id,
      name: a.attributes.name,
      bundle: a.attributes.bundleId,
      sku: a.attributes.sku
    })
  }

  // 2. Sales units (last 7 + 28 days) if we have a vendor number
  let sales7 = {}, sales28 = {}
  const vendor = vendorNumber || process.env.ASC_VENDOR_NUMBER
  if (vendor) {
    for (let d = 1; d <= 28; d++) {
      const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10)
      let rep
      try { rep = await salesUnits(vendor, day) } catch { rep = null }
      if (!rep) continue
      for (const [sku, info] of Object.entries(rep)) {
        sales28[sku] = (sales28[sku] || 0) + info.units
        if (d <= 7) sales7[sku] = (sales7[sku] || 0) + info.units
      }
    }
  }
  for (const app of out) {
    app.installs7 = sales7[app.sku] ?? null
    app.installs28 = sales28[app.sku] ?? null
  }
  return { apps: out, hasVendor: !!vendor }
}

// CLI: node numbers/asc.mjs  → prints what we can see
if (import.meta.url === `file://${process.argv[1]}`) {
  const vendorArg = process.argv.find(a => a.startsWith('--vendor='))
  getAppMetrics({ vendorNumber: vendorArg ? vendorArg.split('=')[1] : undefined })
    .then(r => {
      console.log('Apps visible to this API key:')
      for (const a of r.apps) {
        console.log(`  ${a.name}  [${a.bundle}]  sku=${a.sku}  id=${a.id}  ` +
          (r.hasVendor ? `installs 7d=${a.installs7} 28d=${a.installs28}` : '(no vendor # — sales not pulled)'))
      }
    })
    .catch(e => { console.error('FATAL:', e.message); process.exit(1) })
}
