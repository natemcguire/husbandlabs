# husbandlabs-analytics

First-party, cookieless analytics. One Worker + one D1. No Google, no cookies,
no stored IP. Personal sites only.

- **Collect:** `POST https://husbandlabs-analytics.nate-mcguire.workers.dev/e`
- **Query:** `GET .../q?token=$QUERY_TOKEN[&site=<host>&days=N]`
- **Beacon:** paste `beacon.html` before `</body>` on each site.
- **Retention:** raw hits pruned after 90 days (daily cron).

Visitor id = daily-rotating SHA-256(day|site|ip|ua), first 8 bytes. Not a
cookie, not correlatable across days or to a person (Plausible model).

`QUERY_TOKEN` is a Worker secret + lives in `~/.config/keys/keys.env` as
`ANALYTICS_TOKEN`. Deploy: `wrangler deploy`. Schema: `schema.sql`.

## Tests

`npm test` — 19 tests, no deps. The D1 mock is backed by real in-memory
SQLite (`node:sqlite`), so the aggregation SQL is executed for real, not
faked. Covers helpers, collect (incl. the Origin-spoofing regression),
query auth + math, day clamping, prune, routing, and no-leak 500s.

## Known limitations (honest)

- **Ingestion is unauthenticated.** `/e` accepts any POST. At personal
  scale that's fine, but a determined actor could spam fake hits or burn
  the D1 free write quota (~100k/day). The 90-day prune bounds storage,
  not write volume. No per-IP throttle — deliberately out of scope.
- **`site` trusts the browser Origin**, falling back to the payload's `s`
  only when Origin is absent (rare for cross-origin sendBeacon). Page JS
  cannot forge a cross-origin Origin, so normal spoofing is blocked; a
  non-browser client with no Origin can still mislabel its own hits.
- **`QUERY_TOKEN` travels in the URL** (`/q?token=`), so it can land in
  Cloudflare request logs. It guards read-only aggregate stats on a
  personal tool — accepted tradeoff, not a credential worth rotating often.
- **Visitor counts are per-day uniques** (the hash embeds the date and
  rotates), so a visitor active on 3 days counts as 3 — same model as
  Plausible. Not a bug; it's the privacy guarantee.
- SPA route changes aren't tracked (beacon fires on full load only). Fine
  for the current sites (full-nav); would undercount a client-routed SPA.
