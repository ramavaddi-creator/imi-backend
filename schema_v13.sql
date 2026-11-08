-- IMI ONE round 4: Brand settings (members, Brand Facts, profile, AI services, activity).
-- PROPOSED. Staging first; production only after approval and a backup. Additive only.

-- Statements that must stay exact, and the wrong forms to block (Master Requirements 5).
CREATE TABLE IF NOT EXISTS brand_facts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  statement TEXT NOT NULL,
  wrong_forms_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_by TEXT,
  retired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_brand_facts ON brand_facts (workspace_id, retired_at);

-- Every membership change, append-only (who did what to whom, and when).
CREATE TABLE IF NOT EXISTS member_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor TEXT NOT NULL,
  subject_email TEXT NOT NULL,
  change TEXT NOT NULL,             -- added:<role> | role:<from>-><to> | revoked
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_member_events ON member_events (workspace_id, created_at);
CREATE TRIGGER IF NOT EXISTS member_events_no_update BEFORE UPDATE ON member_events BEGIN SELECT RAISE(ABORT, 'member_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS member_events_no_delete BEFORE DELETE ON member_events BEGIN SELECT RAISE(ABORT, 'member_events is append-only'); END;
