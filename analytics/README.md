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
