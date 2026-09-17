-- IMI backend — Wave 0, third slice: finishes decoupling verification from
-- workflow on inbox_items (per adversarial review), and adds decision
-- hypothesis fields so a Decision can state what it expects before Outcome
-- tells us what actually happened.

ALTER TABLE inbox_items ADD COLUMN verification_status TEXT DEFAULT 'unverified';
ALTER TABLE decision_items ADD COLUMN expected_outcome TEXT;
ALTER TABLE decision_items ADD COLUMN measurement_criteria TEXT;
