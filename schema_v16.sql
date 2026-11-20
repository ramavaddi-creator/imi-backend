-- IMI ONE round 10: Build 1, Instagram read-only (design section 2). PROPOSED; staging first.
-- Reads account identity, posts and the insights Meta makes available. No publishing, comments,
-- messages, webhooks or ads. The token is encrypted, bound to brand + account, and never returned.

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  platform TEXT NOT NULL CHECK (platform IN ('instagram')),
  external_account_id TEXT,              -- Instagram professional account id (17841...)
  username TEXT,
  expected_username TEXT NOT NULL,       -- typed by the owner; a different account is refused
  account_type TEXT,
  auth_method TEXT NOT NULL DEFAULT 'instagram_login',
  token_ciphertext TEXT,                 -- AES-GCM, fresh nonce, AAD = workspace|instagram|account id
  key_version INTEGER,
  token_obtained_at TEXT,
  token_expires_at TEXT,                 -- known after the first successful refresh
  permissions_json TEXT NOT NULL DEFAULT '{}', -- what calls have proven: {"basic":true,"insights":true}
  status TEXT NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected', 'connected', 'needs_reconnect', 'revoked')),
  followers_count INTEGER,
  media_count INTEGER,
  backfill_cursor TEXT,                  -- where to continue fetching older posts
  last_sync_at TEXT,
  last_error TEXT,                       -- redacted
  last_test_json TEXT,                   -- redacted connection-test report
  connected_by TEXT,
  connected_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, platform)
);
-- One Instagram account belongs to one brand only.
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_accounts_external ON social_accounts (platform, external_account_id) WHERE external_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS social_media (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES social_accounts(id),
  external_media_id TEXT NOT NULL,
  media_type TEXT,                       -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type TEXT,               -- FEED | REELS | STORY | AD
  caption TEXT,
  permalink TEXT,
  published_at TEXT,
  like_count INTEGER,
  comments_count INTEGER,
  first_seen_run_id TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  UNIQUE (account_id, external_media_id)
);
CREATE INDEX IF NOT EXISTS idx_social_media_ws ON social_media (workspace_id, published_at);

-- Metric history: a new row only when a value changes; nothing is overwritten.
-- A metric Meta does not return has no row and is shown as "unavailable", never 0.
CREATE TABLE IF NOT EXISTS social_metrics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  media_id TEXT,                         -- NULL for account-level figures
  metric TEXT NOT NULL,                  -- Meta's own metric name
  value REAL NOT NULL,
  period TEXT NOT NULL,                  -- lifetime | day
  period_end TEXT NOT NULL,              -- YYYY-MM-DD for day; 'lifetime' for lifetime
  run_id TEXT NOT NULL,
  retrieved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_metrics_key ON social_metrics (account_id, media_id, metric, period, period_end, retrieved_at);
CREATE TRIGGER IF NOT EXISTS social_metrics_no_update BEFORE UPDATE ON social_metrics
BEGIN SELECT RAISE(ABORT, 'metric history is append-only'); END;

-- Metrics Meta declined for a post (e.g. a story under 5 viewers), so the gap is explained.
CREATE TABLE IF NOT EXISTS social_limitations (
  account_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (account_id, media_id)
);
