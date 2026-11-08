-- Explicit brand assignment, after the read-only inventory and founder approval.
-- Inventory of 8 Nov 2026: 6 inbox items and 4 records, all labelled
-- 'iddav-marketing-intelligence'; 0 decisions, 0 outcomes, 0 campaigns.
-- Only rows carrying the verified Iddav label are assigned. Anything else, including
-- any row created later with another or no label, stays unassigned (quarantined,
-- invisible to every brand) and is listed by the check at the end.
-- Campaigns have no label column; the inventory found none, so none are assigned.
-- Mapping approved on: ____________  by: ____________
UPDATE decision_items SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL AND domain = 'iddav-marketing-intelligence';
UPDATE inbox_items SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL AND domain = 'iddav-marketing-intelligence';
UPDATE intelligence_records SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL AND domain = 'iddav-marketing-intelligence';
UPDATE outcome_items SET workspace_id = 'ws-iddav' WHERE workspace_id IS NULL AND domain = 'iddav-marketing-intelligence';
-- Check: anything still unassigned, per table (expected 0 for the 8 Nov inventory).
SELECT (SELECT COUNT(*) FROM inbox_items WHERE workspace_id IS NULL) AS inbox_unassigned, (SELECT COUNT(*) FROM intelligence_records WHERE workspace_id IS NULL) AS records_unassigned, (SELECT COUNT(*) FROM decision_items WHERE workspace_id IS NULL) AS decisions_unassigned, (SELECT COUNT(*) FROM outcome_items WHERE workspace_id IS NULL) AS outcomes_unassigned, (SELECT COUNT(*) FROM campaigns WHERE workspace_id IS NULL) AS campaigns_unassigned;
