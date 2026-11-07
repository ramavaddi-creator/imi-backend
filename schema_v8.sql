-- Gate 1 (F-17): append-only history of decision approval changes.
-- PROPOSED, NOT APPLIED. Apply only after founder approval:
--   wrangler d1 execute imi-db --remote --file=schema_v8.sql
-- Additive: creates one new table and two triggers; changes no existing data.
-- Rollback: leaving it in place is harmless to older code.
CREATE TABLE IF NOT EXISTS decision_events (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decision_items(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,             -- verified Cloudflare Access email, set by the server
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_events ON decision_events(decision_id, created_at);

-- Rows can be added, never changed or removed, through any application query.
CREATE TRIGGER IF NOT EXISTS decision_events_no_update BEFORE UPDATE ON decision_events
BEGIN SELECT RAISE(ABORT, 'decision_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS decision_events_no_delete BEFORE DELETE ON decision_events
BEGIN SELECT RAISE(ABORT, 'decision_events is append-only'); END;
