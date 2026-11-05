-- IMI backend v5 — Content Studio and Connections
-- Pilot scope under DEC-IMI-002 (docs/decisions/DEC-IMI-002.md).
-- Apply once:  npx wrangler d1 execute imi-db --remote --file=schema_v5.sql

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Encrypted platform credentials (AES-GCM, key = CONNECTIONS_KEY secret).
CREATE TABLE IF NOT EXISTS connections (
  platform TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  secret_enc TEXT,
  account_label TEXT,
  expires_at TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_ok INTEGER,
  last_message TEXT
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  settings_json TEXT,
  created_at TEXT NOT NULL
);

-- Every AI call: task, prompt version, model, parameters, tokens, latency, result.
CREATE TABLE IF NOT EXISTS ai_calls (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- text | image
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  params_json TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  images INTEGER,
  latency_ms INTEGER,
  status TEXT NOT NULL,            -- ok | error
  error TEXT,
  entity_type TEXT,
  entity_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_month ON ai_calls(kind, created_at);

-- Files in R2 with authenticity and rights (CIL-FR-001, FR-EVD-010).
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,              -- image | video | poster
  content_type TEXT NOT NULL,
  authenticity TEXT NOT NULL,      -- original | documentary_edit | ai_generated | mixed
  credit TEXT,
  rights_note TEXT,
  original_filename TEXT,
  sha256 TEXT,
  r2_etag TEXT,
  size_bytes INTEGER,
  ai_call_id TEXT REFERENCES ai_calls(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  primary_metric TEXT NOT NULL,
  audience_json TEXT NOT NULL DEFAULT '[]',
  cta_type TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  owner_facts TEXT,
  decision_code TEXT,
  expected_outcome TEXT NOT NULL,
  outcome_window_days INTEGER NOT NULL DEFAULT 14,
  series_label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  series_number INTEGER NOT NULL,
  template TEXT NOT NULL,
  eyebrow TEXT,
  headline TEXT NOT NULL,
  image_prompt TEXT,
  background_asset_id TEXT REFERENCES assets(id),
  background_authenticity TEXT NOT NULL,
  poster_asset_id TEXT REFERENCES assets(id),
  video_asset_id TEXT REFERENCES assets(id),
  copy_provider TEXT,
  copy_model TEXT,
  copy_ai_call_id TEXT REFERENCES ai_calls(id),
  evidence_ids_json TEXT,
  insufficient_evidence INTEGER NOT NULL DEFAULT 0,
  ai_notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | ready | partially_published | published
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, series_number)
);

-- One row per channel per content (CIL-FR-002).
CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES contents(id),
  channel TEXT NOT NULL,
  caption TEXT NOT NULL,
  hashtags_json TEXT,
  title TEXT,
  tracked_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | tested | published | failed
  method TEXT,                          -- api | manual
  external_id TEXT,
  permalink TEXT,
  published_at TEXT,
  last_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (content_id, channel)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES contents(id),
  approval_class TEXT NOT NULL,        -- A | B
  approved_by TEXT NOT NULL,
  note TEXT,
  domain_review_note TEXT,
  content_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_content ON approvals(content_id);

-- Append-only audit of approvals, tests, publishes and manual records.
CREATE TABLE IF NOT EXISTS publication_events (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  publication_id TEXT,
  channel TEXT,
  action TEXT NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT,
  actor TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publication_events_content ON publication_events(content_id, created_at);
