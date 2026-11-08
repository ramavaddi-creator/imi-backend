-- IMI ONE round 5: AI spending controls (Master Requirements 12). PROPOSED; staging first.
-- AI is OFF for a brand until an owner sets a budget and switches it on.
CREATE TABLE IF NOT EXISTS ai_budgets (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  ai_enabled INTEGER NOT NULL DEFAULT 0,             -- the owner's kill switch
  monthly_cap_inr INTEGER NOT NULL DEFAULT 0,
  daily_calls_per_person INTEGER NOT NULL DEFAULT 20,
  provider_caps_json TEXT NOT NULL DEFAULT '{}',      -- {"anthropic": 1500, "openai": 500} in rupees per month
  prices_json TEXT NOT NULL DEFAULT '{}',             -- owner's corrections to the estimate table
  alert_pct INTEGER NOT NULL DEFAULT 80 CHECK (alert_pct BETWEEN 10 AND 100),
  updated_by TEXT,
  updated_at TEXT
);
-- Every AI call carries its brand, person and estimated cost.
ALTER TABLE ai_calls ADD COLUMN workspace_id TEXT;
ALTER TABLE ai_calls ADD COLUMN user_email TEXT;
ALTER TABLE ai_calls ADD COLUMN cost_inr REAL;
CREATE INDEX IF NOT EXISTS idx_ai_calls_ws_month ON ai_calls (workspace_id, created_at);
