// Same-origin proxy for the live PureCalculators dashboard JSON. The dashboard
// HTML is served locally (public/numbers/pc/) but its data must come from
// purecalculators.com — which doesn't send CORS headers and whose extensionless
// /dashboard/ route falls back to the marketing SPA. Proxying the .json (which
// IS served correctly there) keeps the data live + same-origin + behind the
// existing /numbers/* basic-auth middleware.

const ALLOW = new Set(['status.json', 'checklist.json', 'top-earners.json'])

export async function onRequest(context) {
  const file = context.params.file
  if (!ALLOW.has(file)) return new Response('not found', { status: 404 })
  const upstream = await fetch(`https://purecalculators.com/dashboard/${file}`, {
    cf: { cacheTtl: 300, cacheEverything: true },
  })
  if (!upstream.ok) return new Response('upstream error', { status: 502 })
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  })
}
