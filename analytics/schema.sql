CREATE TABLE IF NOT EXISTS hits (
  ts      INTEGER NOT NULL,   -- epoch ms
  day     TEXT    NOT NULL,   -- YYYY-MM-DD (UTC)
  site    TEXT    NOT NULL,   -- hostname, www. stripped
  path    TEXT    NOT NULL,
  ref     TEXT    NOT NULL,   -- referrer domain, or 'direct'
  country TEXT    NOT NULL,   -- ISO-2, or 'XX'
  device  TEXT    NOT NULL,   -- mobile | tablet | desktop
  vis     TEXT    NOT NULL    -- daily-rotating visitor hash (no PII, no cookie)
);
CREATE INDEX IF NOT EXISTS i_site_day ON hits (site, day);
CREATE INDEX IF NOT EXISTS i_ts ON hits (ts);
