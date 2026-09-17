-- IMI backend — Wave 0, first slice: real persistence for Inbox items,
-- replacing the frontend's in-memory mock array.
CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  domain TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  summary TEXT NOT NULL,
  origin TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  submitter_role TEXT NOT NULL,
  confidence_level TEXT,
  confidence_reason TEXT,
  retrospective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  full_text TEXT NOT NULL,
  source_reference TEXT,
  attachments_json TEXT,
  source_category TEXT,
  source_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inbox_items_status ON inbox_items(status);
CREATE INDEX IF NOT EXISTS idx_inbox_items_created_at ON inbox_items(created_at);
