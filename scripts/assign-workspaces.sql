-- TEMPLATE. Do not run until the inventory has been reviewed and the founder has
-- approved the mapping. Assigns brands explicitly, by the existing domain value;
-- anything not matched stays quarantined (invisible to every brand).
-- Mapping approved on: ____________  by: ____________
UPDATE campaigns SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL; -- campaigns have no domain column: confirm in the inventory that all are Iddav's
UPDATE decision_items SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL AND domain = 'iddav-marketing-intelligence';
UPDATE inbox_items SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL AND domain = 'iddav-marketing-intelligence';
UPDATE intelligence_records SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL AND domain = 'iddav-marketing-intelligence';
UPDATE outcome_items SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL AND domain = 'iddav-marketing-intelligence';
-- Afterwards: anything still unassigned is listed for a manual decision.
SELECT 'inbox' AS t, COUNT(*) FROM inbox_items WHERE workspace_id IS NULL
UNION ALL SELECT 'records', COUNT(*) FROM intelligence_records WHERE workspace_id IS NULL
UNION ALL SELECT 'decisions', COUNT(*) FROM decision_items WHERE workspace_id IS NULL
UNION ALL SELECT 'outcomes', COUNT(*) FROM outcome_items WHERE workspace_id IS NULL;
