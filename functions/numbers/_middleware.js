// HTTP Basic Auth gate for /numbers/* only (the public husbandlabs landing
// page at / is unaffected — Pages Functions middleware is path-scoped to the
// directory it lives in). Protects the dashboard AND its data.json.
//
// Password is the Pages env var NUMBERS_PASSWORD (set via:
//   wrangler pages secret put NUMBERS_PASSWORD --project-name husbandlabs)
// Username is fixed: "nate".

export async function onRequest(context) {
  const { request, env, next } = context
  const expected = 'Basic ' + btoa('nate:' + (env.NUMBERS_PASSWORD || ''))
  const got = request.headers.get('Authorization') || ''

  // Constant-time-ish compare (length check first to avoid trivial leak)
  if (got.length === expected.length && got === expected && env.NUMBERS_PASSWORD) {
    return next()
  }
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="HusbandLabs numbers", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow'
    }
  })
}
