-- IMI ONE round 17: searches grouped by topic (for Iddav: Tadoba, Pench, Kanha, Bandhavgarh,
-- Central India forests and the brand's own name). Read-only Search Console figures; staging first.

CREATE TABLE IF NOT EXISTS search_topics (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  label TEXT NOT NULL,
  words_json TEXT NOT NULL,            -- lower-case words or phrases; a search containing any of them belongs here
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_topics_ws ON search_topics (workspace_id, retired_at, sort);

-- Figures per topic for one fetch window, replaced as a set each fetch.
CREATE TABLE IF NOT EXISTS search_topic_figures (
  workspace_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES search_topics(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  position REAL,
  queries INTEGER NOT NULL,            -- how many different searches Google listed for this topic
  top_json TEXT NOT NULL,              -- up to 5 searches: [{query, impressions, clicks, position}]
  run_id TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, topic_id, period_start, period_end)
);
