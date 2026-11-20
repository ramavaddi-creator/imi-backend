-- IMI ONE round 12: Build 3 completion (parts that need no CRM change). PROPOSED; staging first.
-- (g) Season and demand calendar with reminders 30/14/7 days ahead; (h) a four-week baseline.

-- Dates that move demand: safari season, monsoon core-zone closure (from the official notice each year),
-- holidays and long weekends in the cities guests come from. Entered by an owner, with where the date came from.
CREATE TABLE IF NOT EXISTS brand_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('season', 'closure', 'holiday', 'long_weekend', 'other')),
  start_date TEXT NOT NULL,              -- YYYY-MM-DD
  end_date TEXT NOT NULL,                -- YYYY-MM-DD, same as start for one day
  source TEXT,                           -- e.g. "Tadoba official notice, 2026"
  remind_days_json TEXT NOT NULL DEFAULT '[30,14,7]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_by TEXT,
  retired_at TEXT,
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_brand_events_ws ON brand_events (workspace_id, start_date);

-- The baseline: started once by an owner; a snapshot of the funnel is kept for each week.
CREATE TABLE IF NOT EXISTS baselines (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  started_at TEXT NOT NULL,
  started_by TEXT NOT NULL,
  weeks INTEGER NOT NULL DEFAULT 4 CHECK (weeks BETWEEN 2 AND 12),
  note TEXT
);
CREATE TABLE IF NOT EXISTS funnel_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  week_start TEXT NOT NULL,              -- Monday, YYYY-MM-DD
  week_end TEXT NOT NULL,                -- Sunday
  figures_json TEXT NOT NULL,            -- {stage: {value, status, source}}
  taken_at TEXT NOT NULL,
  taken_by TEXT,                         -- NULL = the weekly schedule
  UNIQUE (workspace_id, week_start)
);
CREATE TRIGGER IF NOT EXISTS funnel_snapshots_no_update BEFORE UPDATE ON funnel_snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are kept as taken'); END;
