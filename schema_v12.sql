-- IMI ONE round 3: scheduling, calendar, and outcomes linked to posted drafts.
-- PROPOSED. Staging first; production only after approval and a backup. Additive only.
ALTER TABLE drafts ADD COLUMN scheduled_for TEXT;       -- ISO time in UTC; only an approved draft can be scheduled
ALTER TABLE drafts ADD COLUMN scheduled_channel TEXT;
CREATE INDEX IF NOT EXISTS idx_drafts_schedule ON drafts (workspace_id, scheduled_for);
-- Outcomes belong to the published content (record -> decision -> draft -> post -> outcome).
ALTER TABLE outcome_items ADD COLUMN draft_id TEXT REFERENCES drafts(id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_outcome_draft ON outcome_items (draft_id) WHERE draft_id IS NOT NULL;
INSERT OR IGNORE INTO code_counters (name, n) SELECT 'OUT', COALESCE(MAX(CAST(substr(code, 5) AS INTEGER)), 0) FROM outcome_items WHERE code LIKE 'OUT-%';
