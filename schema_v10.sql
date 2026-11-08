-- IMI ONE round 1 (revision 2): brand ownership and integrity of the intelligence loop.
-- PROPOSED, NOT APPLIED to production. Staging first; production only after approval
-- and a backup (wrangler d1 export imi-db --remote --output imi-db-before-v10.sql).
-- Additive only: new columns, tables and indexes. Rollback = deploy the previous Worker;
-- older code ignores everything added here.
--
-- No row is given a brand here. Rows without workspace_id are invisible to every
-- brand (quarantined) until assigned explicitly after the read-only inventory
-- (scripts/inventory.sql, then scripts/assign-workspaces.sql).

ALTER TABLE inbox_items ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE intelligence_records ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE outcome_items ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

-- Provenance of captured items (where it came from, when published, when retrieved, what kind of evidence).
ALTER TABLE inbox_items ADD COLUMN feed_source TEXT;
ALTER TABLE inbox_items ADD COLUMN source_item_id TEXT;
ALTER TABLE inbox_items ADD COLUMN published_at TEXT;
ALTER TABLE inbox_items ADD COLUMN retrieved_at TEXT;
ALTER TABLE inbox_items ADD COLUMN evidence_class TEXT
  CHECK (evidence_class IS NULL OR evidence_class IN ('official','research','observation_record','reporting','opinion','unverified'));
-- The same source item is captured once per brand.
CREATE UNIQUE INDEX IF NOT EXISTS ux_inbox_source_item ON inbox_items (workspace_id, feed_source, source_item_id) WHERE source_item_id IS NOT NULL;

-- One record per inbox item, enforced by the database.
ALTER TABLE inbox_items ADD COLUMN promoted_record_id TEXT REFERENCES intelligence_records(id);
ALTER TABLE intelligence_records ADD COLUMN source_inbox_id TEXT REFERENCES inbox_items(id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_records_source_inbox ON intelligence_records (source_inbox_id) WHERE source_inbox_id IS NOT NULL;

-- Decisions made on the record: retries are recognised (request_id), revisions supersede.
ALTER TABLE decision_items ADD COLUMN record_id TEXT REFERENCES intelligence_records(id);
ALTER TABLE decision_items ADD COLUMN request_id TEXT;
ALTER TABLE decision_items ADD COLUMN superseded_by TEXT REFERENCES decision_items(id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_decisions_request ON decision_items (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_record ON decision_items (record_id, superseded_by);

-- A draft made because of a record points back to it (record -> decision -> draft -> post -> outcome).
ALTER TABLE contents ADD COLUMN source_record_id TEXT REFERENCES intelligence_records(id);

-- Per-brand settings held on the server: the record domain and the feed profile (subject, area).
ALTER TABLE workspaces ADD COLUMN record_domain TEXT;
ALTER TABLE workspaces ADD COLUMN feed_profile_json TEXT;
UPDATE workspaces SET record_domain = 'iddav-marketing-intelligence',
  feed_profile_json = '{"query":"Panthera tigris","lat":20.2167,"lng":79.3667,"radiusKm":60,"country":"IN","newsKeywords":["tiger","tadoba","leopard","maharashtra","chandrapur","forest","wildlife","buffer"]}'
  WHERE id = 'ws-iddav' AND record_domain IS NULL;

-- Code numbers (INB-, INT-, DEC-) from an atomic counter instead of COUNT(*)+1.
-- Each counter starts after the highest code already used.
CREATE TABLE IF NOT EXISTS code_counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
INSERT OR IGNORE INTO code_counters (name, n) SELECT 'INB', COALESCE(MAX(CAST(substr(code, 5) AS INTEGER)), 0) FROM inbox_items WHERE code LIKE 'INB-%';
INSERT OR IGNORE INTO code_counters (name, n) SELECT 'INT', COALESCE(MAX(CAST(substr(code, 5) AS INTEGER)), 0) FROM intelligence_records WHERE code LIKE 'INT-%';
INSERT OR IGNORE INTO code_counters (name, n) SELECT 'DEC', COALESCE(MAX(CAST(substr(code, 5) AS INTEGER)), 0) FROM decision_items WHERE code LIKE 'DEC-%';

-- Guard used inside write batches: inserting a row here (only when a condition failed)
-- breaks the CHECK and rolls the whole batch back. Never holds data.
CREATE TABLE IF NOT EXISTS write_guard (x INTEGER CHECK (x IS NULL));

CREATE INDEX IF NOT EXISTS idx_inbox_workspace ON inbox_items (workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_records_workspace ON intelligence_records (workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_outcomes_workspace ON outcome_items (workspace_id, date_evaluated);
