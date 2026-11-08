-- IMI ONE milestone 1: brands (workspaces) and who may see them.
-- PROPOSED, NOT APPLIED. Apply only after founder approval, after a backup:
--   wrangler d1 export imi-db --remote --output imi-db-before-v9.sql
--   wrangler d1 execute imi-db --remote --file=schema_v9.sql
-- Additive: three new tables and new workspace_id columns. Every existing row is
-- assigned to the Iddav workspace, because all data in IMI today is Iddav's.
-- Rollback: older code ignores the new tables and columns.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,                 -- the customer account (one business owner or company)
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,                 -- one brand: ws-iddav, ws-antardrishti, ws-manas
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- hospitality | app | research | shop | service | restaurant | personal | real_estate
  description TEXT NOT NULL DEFAULT '',
  goal_key TEXT NOT NULL,              -- qualified_enquiries | sign_ups | screener_completions | sales | followers
  max_headline_words INTEGER,
  created_at TEXT NOT NULL
);

-- Who belongs to which brand, in which role. Email is the verified Cloudflare Access identity.
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL CHECK (email = lower(email)),
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'creator', 'sales', 'viewer')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_memberships_active ON memberships (workspace_id, email) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memberships_email ON memberships (email) WHERE revoked_at IS NULL;

-- Brand ownership of existing records.
ALTER TABLE campaigns ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE decision_items ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX IF NOT EXISTS idx_campaigns_workspace ON campaigns (workspace_id);
CREATE INDEX IF NOT EXISTS idx_decision_items_workspace ON decision_items (workspace_id, approval_status);

-- Everything in IMI today belongs to Iddav.
INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES ('tnt-rama', 'Rama Krishna Vaddi', strftime('%Y-%m-%dT%H:%M:%SZ','now'));
INSERT OR IGNORE INTO workspaces (id, tenant_id, name, kind, description, goal_key, max_headline_words, created_at)
  VALUES ('ws-iddav', 'tnt-rama', 'Iddav WildStay', 'hospitality', 'Sri Antra eco-lodge in the buffer zone of Tadoba Andhari Tiger Reserve.', 'qualified_enquiries', 12, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
UPDATE campaigns SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL;
UPDATE decision_items SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL;
-- Owners are added per environment (see seed_staging.sql and the deployment guide), never here.
