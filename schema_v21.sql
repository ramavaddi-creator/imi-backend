-- IMI ONE round 14: Build 5, partner and corporate outreach. PROPOSED; staging first.
-- Business contacts only (organisations: travel agents, companies, schools, event planners). Every email is
-- sent by a person from their own mail app; nothing is sent by IMI ONE. Anyone who opts out is never contacted again.

-- The ideal-partner profile: segments (who, what we offer them, words that show a fit), cities, daily limit, sender.
CREATE TABLE IF NOT EXISTS partner_profiles (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  profile_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prospects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  segment TEXT NOT NULL,
  name TEXT NOT NULL,                     -- the organisation
  contact_person TEXT,                    -- a business contact, only if public or given
  email TEXT,                             -- a business address
  website TEXT,
  phone TEXT,
  city TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual', 'csv', 'osm')),
  source_ref TEXT,                        -- e.g. osm:node/123
  score INTEGER,                          -- 0 to 100, from the website check; null until checked
  signals_json TEXT NOT NULL DEFAULT '[]',-- why the score is what it is
  checked_at TEXT,
  check_error TEXT,
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'replied', 'meeting', 'partner', 'not_interested', 'opted_out', 'archived')),
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospects_ws ON prospects (workspace_id, stage, segment);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_ref ON prospects (workspace_id, source_ref) WHERE source_ref IS NOT NULL;

-- Email sequences per segment (3 emails), written with AI and approved by an owner. Versions are kept.
CREATE TABLE IF NOT EXISTS outreach_sequences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  segment TEXT NOT NULL,
  version INTEGER NOT NULL,
  emails_json TEXT NOT NULL,              -- [{step, delayDays, subject, body}]
  source TEXT NOT NULL,                   -- the AI service, or "typed"
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'replaced')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  UNIQUE (workspace_id, segment, version)
);

-- One email per step per prospect, merged from the approved sequence.
CREATE TABLE IF NOT EXISTS outreach_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  prospect_id TEXT NOT NULL REFERENCES prospects(id),
  sequence_id TEXT NOT NULL REFERENCES outreach_sequences(id),
  step INTEGER NOT NULL,
  delay_days INTEGER NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'ready', 'sent', 'skipped', 'stopped')),
  due_at TEXT,
  sent_by TEXT,
  sent_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (prospect_id, step)
);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_ws ON outreach_messages (workspace_id, status, due_at);

CREATE TABLE IF NOT EXISTS outreach_replies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  prospect_id TEXT NOT NULL REFERENCES prospects(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('interested', 'meeting', 'partner', 'not_now', 'not_interested', 'opt_out', 'bounced', 'other')),
  note TEXT,
  logged_by TEXT NOT NULL,
  logged_at TEXT NOT NULL
);

-- Never contact again: an email address or a whole domain. Rows are never deleted.
CREATE TABLE IF NOT EXISTS outreach_suppressions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  value TEXT NOT NULL,                    -- lower-case email, or @domain
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, value)
);
CREATE TRIGGER IF NOT EXISTS outreach_suppressions_keep BEFORE DELETE ON outreach_suppressions
BEGIN SELECT RAISE(ABORT, 'Opt-outs are kept: once someone opts out, they are never contacted again.'); END;
