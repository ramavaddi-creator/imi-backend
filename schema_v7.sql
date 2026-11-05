-- IMI backend v7 — more channels, outside creative tools, video posting
-- Apply once after v6:  npx wrangler d1 execute imi-db --remote --file=schema_v7.sql

ALTER TABLE publications ADD COLUMN extra_json TEXT;            -- Google Ads headlines/descriptions, website meta description
ALTER TABLE contents ADD COLUMN media_mode TEXT NOT NULL DEFAULT 'poster';   -- poster | video
ALTER TABLE contents ADD COLUMN ai_media_tool TEXT;            -- e.g. runway, flow, gemini (drives the AI disclosure)
ALTER TABLE contents ADD COLUMN requires_class_a INTEGER NOT NULL DEFAULT 0; -- AI media showing animals
ALTER TABLE contents ADD COLUMN poster_source TEXT NOT NULL DEFAULT 'composed'; -- composed | imported

-- Prompts written by Claude/ChatGPT for outside tools, kept for provenance.
CREATE TABLE IF NOT EXISTS creative_briefs (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES contents(id),
  tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  ai_call_id TEXT REFERENCES ai_calls(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creative_briefs_content ON creative_briefs(content_id);
