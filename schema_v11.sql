-- IMI ONE round 2: Send to AI, Bring back from AI, drafts, approval, Mark as posted.
-- PROPOSED. Staging first; production only after approval and a backup. Additive only.

-- AI destinations per brand (Master Requirements 3.1: provider registry).
CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL CHECK (url LIKE 'https://%'),
  kind TEXT NOT NULL DEFAULT 'website' CHECK (kind IN ('website', 'api')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

-- Every hand-off to an AI is logged (3.3: provider, time, source record, data classification).
CREATE TABLE IF NOT EXISTS ai_handoffs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  record_id TEXT NOT NULL REFERENCES intelligence_records(id),
  provider TEXT NOT NULL,
  data_class TEXT NOT NULL,
  redactions INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_record ON ai_handoffs (workspace_id, record_id, created_at);

-- Drafts: what comes back from an AI (or is written by hand), linked to its record.
-- Editing a draft creates a new version and clears any approval; only the approved
-- version can be marked as posted, and posting needs the link to the live post.
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  record_id TEXT REFERENCES intelligence_records(id),
  headline TEXT NOT NULL,
  caption TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'single image',
  source TEXT NOT NULL,                 -- 'Written here' or the AI provider's name
  media_key TEXT,                       -- private R2 key; never public until posted
  media_type TEXT,
  ai_generated_media INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'posted')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_by TEXT, approved_at TEXT, approved_version INTEGER,
  posted_url TEXT, posted_channel TEXT, posted_by TEXT, posted_at TEXT,
  CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_version = version)),
  CHECK (status <> 'posted' OR (posted_url IS NOT NULL AND posted_url LIKE 'https://%'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_workspace ON drafts (workspace_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_drafts_record ON drafts (record_id);
