-- IMI ONE round 11: Build 4, the Content Engine (design section 5). PROPOSED; staging first.
-- One idea -> a content pack -> drafts per format, each needing owner approval of its exact version.
-- Brand Kits and format templates are VERSIONED and IMMUTABLE: a change is a new version, so every
-- past pack, draft and approval stays tied to the exact rules in force when it was generated.

CREATE TABLE IF NOT EXISTS brand_kit_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version INTEGER NOT NULL,
  kit_json TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, version)
);
CREATE TRIGGER IF NOT EXISTS brand_kit_versions_no_update BEFORE UPDATE ON brand_kit_versions
BEGIN SELECT RAISE(ABORT, 'brand kit versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS brand_kit_versions_no_delete BEFORE DELETE ON brand_kit_versions
BEGIN SELECT RAISE(ABORT, 'brand kit versions are immutable'); END;

-- Pointer only: which version is current for a brand.
CREATE TABLE IF NOT EXISTS brand_kits (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  current_version_id TEXT NOT NULL REFERENCES brand_kit_versions(id)
);

-- Format specialists are data: added once, available to every brand.
CREATE TABLE IF NOT EXISTS format_template_versions (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (template_key, version)
);
CREATE TRIGGER IF NOT EXISTS format_template_versions_no_update BEFORE UPDATE ON format_template_versions
BEGIN SELECT RAISE(ABORT, 'format template versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS format_template_versions_no_delete BEFORE DELETE ON format_template_versions
BEGIN SELECT RAISE(ABORT, 'format template versions are immutable'); END;

CREATE TABLE IF NOT EXISTS content_packs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_record_id TEXT REFERENCES intelligence_records(id),   -- NULL for an owner idea
  input_kind TEXT NOT NULL CHECK (input_kind IN ('record', 'voice_note', 'typed_idea')),
  input_text TEXT NOT NULL,
  input_provenance_json TEXT NOT NULL,                         -- who, when, how; "owner idea, not evidence"
  brand_kit_version_id TEXT NOT NULL REFERENCES brand_kit_versions(id),
  templates_json TEXT NOT NULL,                                -- [{key, id, version}] fixed at creation
  idea_map_json TEXT,                                          -- hook, story, proof, audience
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'drafted')),
  route TEXT CHECK (route IN ('send_to_ai', 'direct_ai')),
  est_cost_inr REAL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_packs_ws ON content_packs (workspace_id, created_at);

-- Hand-offs of a pack to an outside AI (owner ideas have no record, so ai_handoffs cannot hold them).
CREATE TABLE IF NOT EXISTS pack_handoffs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pack_id TEXT NOT NULL REFERENCES content_packs(id),
  provider TEXT NOT NULL,
  route TEXT NOT NULL,
  redactions INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE drafts ADD COLUMN pack_id TEXT REFERENCES content_packs(id);
ALTER TABLE drafts ADD COLUMN format_template_version_id TEXT REFERENCES format_template_versions(id);
ALTER TABLE drafts ADD COLUMN brand_kit_version_id TEXT REFERENCES brand_kit_versions(id);
-- What the approval was given against (kit and template versions are copied at approval time).
ALTER TABLE drafts ADD COLUMN approved_kit_version_id TEXT;
ALTER TABLE drafts ADD COLUMN approved_template_version_id TEXT;
CREATE INDEX IF NOT EXISTS idx_drafts_pack ON drafts (pack_id);

-- ---------------------------------------------------------------- format templates, version 1
INSERT OR IGNORE INTO format_template_versions (id, template_key, version, name, channel, rules_json, prompt_template, created_at) VALUES
('ftv-carousel-1', 'carousel', 1, 'Instagram carousel', 'Instagram', '{"slides":[5,7],"maxHashtags":5,"useKitHeadlineLimit":true}',
 'An Instagram carousel of 5 to 7 slides. HEADLINE is slide 1, the hook. In the body, write SLIDES: one numbered line per slide, one idea per slide; the last slide asks people to save or share. Then CAPTION: with one save or share trigger and at most 5 hashtags.', '2026-11-20T00:00:00Z'),
('ftv-reel-1', 'reel_script', 1, 'Reel script', 'Instagram', '{"seconds":[15,30],"maxHashtags":5,"useKitHeadlineLimit":true}',
 'A 15 to 30 second reel. HEADLINE is the spoken hook for the first 2 seconds. In the body, write SCRIPT: 3 to 5 beats, each with what is seen and the on-screen text, ending with one call to action. Then CAPTION:.', '2026-11-20T00:00:00Z'),
('ftv-poster-1', 'poster_text', 1, 'Poster text', 'Instagram', '{"usePosterLimit":true,"maxHashtags":5}',
 'A single poster. HEADLINE is the only text on the poster: one idea, within the brand''s word limit for posters. In the body, write CAPTION: for the post.', '2026-11-20T00:00:00Z'),
('ftv-caption-1', 'caption', 1, 'Feed caption', 'Instagram', '{"maxChars":2200,"maxHashtags":5,"useKitHeadlineLimit":true}',
 'A feed caption. HEADLINE is the first line people see, the hook. In the body, write CAPTION: the full caption, under 2,200 characters, with one save or share trigger and at most 5 hashtags.', '2026-11-20T00:00:00Z'),
('ftv-story-1', 'story', 1, 'Story (3 frames)', 'Instagram', '{"frames":3,"maxHashtags":0,"useKitHeadlineLimit":true}',
 'An Instagram story of 3 frames. HEADLINE is frame 1. In the body, write FRAMES: three numbered lines; one frame asks a question or runs a poll.', '2026-11-20T00:00:00Z'),
('ftv-linkedin-1', 'linkedin_post', 1, 'LinkedIn post', 'LinkedIn', '{"words":[120,220],"maxHashtags":3,"useKitHeadlineLimit":true}',
 'A LinkedIn post of 120 to 220 words. HEADLINE is its first line, the hook. In the body, write CAPTION: the post, with at most 3 hashtags.', '2026-11-20T00:00:00Z'),
('ftv-whatsapp-1', 'whatsapp_status', 1, 'WhatsApp status', 'WhatsApp Status', '{"usePosterLimit":true,"maxHashtags":0}',
 'A WhatsApp status. HEADLINE is the line on the image, within the brand''s word limit for posters. In the body, write CAPTION: one short line under it, no hashtags.', '2026-11-20T00:00:00Z');

-- ---------------------------------------------------------------- starting Brand Kits, version 1
-- Each is inserted only if that brand exists. Owners change them in Brand settings (new versions).
INSERT OR IGNORE INTO brand_kit_versions (id, workspace_id, version, kit_json, note, created_by, created_at)
SELECT 'bkv-iddav-1', 'ws-iddav', 1, '{"description":"Sri Antra eco-lodge in the buffer zone of Tadoba Andhari Tiger Reserve.","audiences":["Families from Hyderabad, Nagpur, Pune and Mumbai planning a Tadoba safari","Wildlife photographers"],"voice":"Calm, observant, specific. NatGeo meets Aman: real moments, no hype.","visual":{"colours":[{"name":"Black","hex":"#080F08"},{"name":"Gold","hex":"#C9A84C"},{"name":"Cream","hex":"#F0E8CC"}],"fonts":["Cormorant Garamond","Montserrat"],"imageRules":["Never present an AI image as a real photograph of wildlife, people or the property","Gold only on the eyebrow and divider"]},"formats":["carousel","reel_script","poster_text","caption","story"],"maxPosterWords":12,"maxHeadlineWords":12,"hookRule":true,"cadence":{"maxGapDays":3,"rotation":"no_three_same","preferredTime":"18:30"},"goal":"Bookings (qualified enquiries that book)","compliance":["Say 27 years of total experience and 5 years in the forest; never \"27 years in the forest\"","No promises of tiger sightings"],"neverSend":["Guest names, phone numbers or emails","Prices not approved in the CRM"]}',
  'Starting kit (round 11)', 'seed', '2026-11-20T00:00:00Z'
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-iddav');

INSERT OR IGNORE INTO brand_kit_versions (id, workspace_id, version, kit_json, note, created_by, created_at)
SELECT 'bkv-antardrishti-1', 'ws-antardrishti', 1, '{"description":"Antardrishti: Vedic astrology app with calculated Panchangam.","audiences":["People who follow Vedic tradition and want accurate daily Panchangam"],"voice":"Respectful, precise, educational.","visual":{"colours":[],"fonts":[],"imageRules":["Label calculated figures as calculated"]},"formats":["carousel","caption","story","whatsapp_status"],"maxPosterWords":12,"maxHeadlineWords":12,"hookRule":true,"cadence":{"maxGapDays":null,"rotation":null,"preferredTime":null},"goal":"Sign-ups","compliance":["Tradition, not prediction: present meanings as traditional associations, never as predictions or claims of effect on health, money, relationships or events"],"neverSend":["Users'' birth details"]}',
  'Starting kit (round 11)', 'seed', '2026-11-20T00:00:00Z'
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-antardrishti');

INSERT OR IGNORE INTO brand_kit_versions (id, workspace_id, version, kit_json, note, created_by, created_at)
SELECT 'bkv-manas-1', 'ws-manas', 1, '{"description":"MANAS research study.","audiences":["Prospective research volunteers"],"voice":"Clear, careful, non-clinical.","visual":{"colours":[],"fonts":[],"imageRules":[]},"formats":["caption","poster_text","linkedin_post"],"maxPosterWords":12,"maxHeadlineWords":12,"hookRule":false,"cadence":{"maxGapDays":null,"rotation":null,"preferredTime":null},"goal":"Research volunteers (screener completions)","compliance":["No therapy, diagnosis or treatment claims","Never quote or describe research responses"],"neverSend":["Any research response or participant detail"]}',
  'Starting kit (round 11)', 'seed', '2026-11-20T00:00:00Z'
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-manas');

INSERT OR IGNORE INTO brand_kits (workspace_id, current_version_id) SELECT workspace_id, id FROM brand_kit_versions WHERE version = 1 AND id LIKE 'bkv-%-1';
