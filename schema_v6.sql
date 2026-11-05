-- IMI backend v6 — Iddav CRM inside IMI (enquiry → quote → booking → stay)
-- Apply once after v5:  npx wrangler d1 execute imi-db --remote --file=schema_v6.sql

CREATE TABLE IF NOT EXISTS enquiries (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,              -- ENQ-0001
  property TEXT NOT NULL DEFAULT 'sri_antra',
  -- personal data (deletable; never sent to AI)
  name TEXT,
  phone TEXT,
  email TEXT,
  consent_marketing INTEGER NOT NULL DEFAULT 0,
  consent_recorded_at TEXT,
  first_message TEXT,
  pii_deleted_at TEXT,
  -- source and attribution
  intake TEXT NOT NULL,                   -- whatsapp | call | website_form | instagram_dm | ...
  ref_code TEXT,
  campaign_id TEXT REFERENCES campaigns(id),
  content_id TEXT REFERENCES contents(id),
  channel TEXT,
  attribution TEXT NOT NULL DEFAULT 'unknown', -- tracked | self_reported | operator_attributed | unknown
  attribution_note TEXT,
  utm_json TEXT,
  -- needs
  check_in TEXT,
  check_out TEXT,
  adults INTEGER,
  children INTEGER,
  rooms INTEGER,
  safari TEXT NOT NULL DEFAULT 'undecided',
  budget_note TEXT,
  interests TEXT,
  segment TEXT,
  -- pipeline
  stage TEXT NOT NULL DEFAULT 'new',
  owner TEXT,
  next_action TEXT,
  next_action_due TEXT,
  first_contacted_at TEXT,
  -- quote
  quote_amount REAL,
  quote_nights INTEGER,
  quote_rooms INTEGER,
  quote_inclusions TEXT,
  quote_valid_until TEXT,
  quote_sent_at TEXT,
  est_contribution REAL,
  -- booking / loss
  booked_value REAL,
  room_nights INTEGER,
  booked_at TEXT,
  lost_reason TEXT,
  lost_note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enquiries_stage_due ON enquiries(stage, next_action_due);
CREATE INDEX IF NOT EXISTS idx_enquiries_campaign ON enquiries(campaign_id);

-- Timeline + audit: every stage move, follow-up and note.
CREATE TABLE IF NOT EXISTS enquiry_events (
  id TEXT PRIMARY KEY,
  enquiry_id TEXT NOT NULL REFERENCES enquiries(id),
  kind TEXT NOT NULL,                     -- created | stage | followup | note | privacy
  text TEXT,
  from_stage TEXT,
  to_stage TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enquiry_events ON enquiry_events(enquiry_id, created_at);

-- Rate limiting for the public website form (hashed IP only).
CREATE TABLE IF NOT EXISTS public_submissions (
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_public_submissions ON public_submissions(ip_hash, created_at);
