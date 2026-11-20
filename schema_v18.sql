-- IMI ONE round 11.1: photos and videos on a content pack. PROPOSED; staging first.
-- Files live privately in R2 (never public until posted). Every file says whether it is a real
-- photo/video or AI-made, so an AI image is never presented as a real photograph.
CREATE TABLE IF NOT EXISTS pack_media (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  pack_id TEXT NOT NULL REFERENCES content_packs(id),
  r2_key TEXT NOT NULL,
  media_type TEXT NOT NULL,              -- image/jpeg, image/png, image/webp, video/mp4, video/quicktime, video/webm
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  origin TEXT NOT NULL CHECK (origin IN ('real', 'ai_made')),
  bytes INTEGER NOT NULL,
  file_name TEXT,
  note TEXT,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pack_media_pack ON pack_media (pack_id, uploaded_at);
-- Which pack file a draft uses (the draft keeps its own media_key, so approval covers the exact file).
ALTER TABLE drafts ADD COLUMN pack_media_id TEXT REFERENCES pack_media(id);
