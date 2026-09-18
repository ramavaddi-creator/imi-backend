-- IMI backend — Wave 0, fourth slice: adds evidence_weight and
-- commercial_relevance to inbox_items, matching what intelligence_records
-- already had, so these fields set at capture time actually persist.

ALTER TABLE inbox_items ADD COLUMN evidence_weight TEXT;
ALTER TABLE inbox_items ADD COLUMN commercial_relevance TEXT;
