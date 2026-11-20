-- IMI ONE round 13: the brand's official links, and tracked links for each place they are shared. PROPOSED; staging first.
-- One active link per kind and brand. A changed link is a new row (the old one is retired), so the history stays.
-- "Checked" means an owner opened the link and confirmed it is the brand's own; changing the link clears it.
CREATE TABLE IF NOT EXISTS brand_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('website', 'whatsapp', 'email', 'google_review', 'instagram', 'facebook', 'youtube', 'threads', 'linkedin')),
  url TEXT NOT NULL,                     -- normalised: https, tracking from other tools removed; email as mailto:
  notes_json TEXT NOT NULL DEFAULT '[]', -- what was cleaned or needs attention, e.g. a LinkedIn personal profile
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  verified_by TEXT,
  verified_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_by TEXT,
  retired_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_links_active ON brand_links (workspace_id, kind) WHERE retired_at IS NULL;
