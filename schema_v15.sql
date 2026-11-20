-- IMI ONE round 9: Build 3, search and guest acquisition (measurement first). PROPOSED; staging first.
-- Read-only Google connectors (Search Console, GA4) and hand-entered Business Profile figures.
-- Every connection shows five separate states; one state never implies the next.
-- Tokens are encrypted, bound to brand + connector + account, and never leave the Worker.

CREATE TABLE IF NOT EXISTS google_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  connector TEXT NOT NULL CHECK (connector IN ('search_console', 'ga4', 'business_profile')),
  resource TEXT,                         -- Search Console site (https://... or sc-domain:...), GA4 property id, or Business Profile location
  settings_json TEXT NOT NULL DEFAULT '{}', -- GA4 event names for enquiry and WhatsApp tap
  -- State 2: 'unknown' until the owner confirms it or an API call proves it either way.
  api_enabled TEXT NOT NULL DEFAULT 'unknown' CHECK (api_enabled IN ('unknown', 'confirmed', 'proven', 'no')),
  -- State 4: property access / Google access approval or non-zero quota.
  access_approved TEXT NOT NULL DEFAULT 'unknown' CHECK (access_approved IN ('unknown', 'confirmed', 'proven', 'no')),
  token_ciphertext TEXT,                 -- AES-GCM, fresh nonce, AAD = workspace|connector|resource
  key_version INTEGER,
  scopes TEXT,                           -- granted scopes, space separated
  status TEXT NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected', 'connected', 'needs_reconnect', 'revoked')),
  last_error TEXT,                       -- redacted
  last_sync_at TEXT,
  connected_by TEXT,
  connected_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, connector)
);

-- Every synchronisation (and key rotation) is an auditable record. A partial run is shown as partial.
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'retry', 'rotation')),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'failed')),
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  items_unchanged INTEGER NOT NULL DEFAULT 0,
  items_changed INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  retries_json TEXT NOT NULL DEFAULT '[]',
  window_start TEXT,
  window_end TEXT,
  error_summary TEXT,                    -- redacted
  resumed_from_run_id TEXT,
  started_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_ws ON sync_runs (workspace_id, connector, started_at);

-- Search Console: one row per day for the brand's site.
CREATE TABLE IF NOT EXISTS search_daily (
  workspace_id TEXT NOT NULL,
  date TEXT NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  position REAL,
  run_id TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, date)
);

-- Search Console: top searches for a period (keyword figures stay at the search stage; never tied to bookings).
CREATE TABLE IF NOT EXISTS search_queries (
  workspace_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  query TEXT NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  position REAL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, period_start, period_end, query)
);

-- GA4: sessions per day per source / medium.
CREATE TABLE IF NOT EXISTS web_daily (
  workspace_id TEXT NOT NULL,
  date TEXT NOT NULL,
  source_medium TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, date, source_medium)
);

-- GA4: chosen key events per day (enquiry submitted, WhatsApp tap). A tap is an interaction, never an enquiry.
CREATE TABLE IF NOT EXISTS web_events (
  workspace_id TEXT NOT NULL,
  date TEXT NOT NULL,
  event_name TEXT NOT NULL,
  count INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, date, event_name)
);

-- Hand-entered monthly figures (Business Profile until Google grants API access). Append-only:
-- a correction is a new row; the old one stays, marked superseded.
CREATE TABLE IF NOT EXISTS manual_metrics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  month TEXT NOT NULL,                   -- YYYY-MM
  metric TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value >= 0),
  note TEXT,
  entered_by TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_manual_metrics_ws ON manual_metrics (workspace_id, connector, month);
CREATE TRIGGER IF NOT EXISTS manual_metrics_no_delete BEFORE DELETE ON manual_metrics
BEGIN SELECT RAISE(ABORT, 'manual figures are append-only'); END;
CREATE TRIGGER IF NOT EXISTS manual_metrics_no_rewrite BEFORE UPDATE OF value, metric, month, workspace_id, entered_by, entered_at ON manual_metrics
BEGIN SELECT RAISE(ABORT, 'manual figures are append-only'); END;
