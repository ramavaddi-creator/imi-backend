-- READ-ONLY inventory of the live IMI database, for the migration mapping report.
-- Only SELECT statements. Run against a copy, or live with:
--   npx wrangler d1 execute imi-db --remote --file=scripts/inventory.sql
SELECT 'inbox_items' AS t, COUNT(*) AS rows, MIN(created_at) AS first, MAX(created_at) AS last FROM inbox_items
UNION ALL SELECT 'intelligence_records', COUNT(*), MIN(created_at), MAX(created_at) FROM intelligence_records
UNION ALL SELECT 'decision_items', COUNT(*), NULL, NULL FROM decision_items
UNION ALL SELECT 'outcome_items', COUNT(*), MIN(date_evaluated), MAX(date_evaluated) FROM outcome_items
UNION ALL SELECT 'campaigns', COUNT(*), MIN(created_at), MAX(created_at) FROM campaigns
UNION ALL SELECT 'contents', COUNT(*), MIN(created_at), MAX(created_at) FROM contents
UNION ALL SELECT 'publications', COUNT(*), NULL, NULL FROM publications;
-- How records are classified today (the domain column is the basis for brand assignment).
SELECT 'inbox' AS t, domain, type AS kind, COUNT(*) AS n FROM inbox_items GROUP BY domain, type
UNION ALL SELECT 'records', domain, record_type, COUNT(*) FROM intelligence_records GROUP BY domain, record_type
UNION ALL SELECT 'decisions', domain, approval_status, COUNT(*) FROM decision_items GROUP BY domain, approval_status
UNION ALL SELECT 'outcomes', domain, NULL, COUNT(*) FROM outcome_items GROUP BY domain;
-- Where intake came from (sources) and duplicate codes, if any.
SELECT source_category, source_type, origin, COUNT(*) AS n FROM inbox_items GROUP BY source_category, source_type, origin ORDER BY n DESC;
SELECT 'inbox' AS t, code, COUNT(*) AS dupes FROM inbox_items GROUP BY code HAVING COUNT(*) > 1
UNION ALL SELECT 'records', code, COUNT(*) FROM intelligence_records GROUP BY code HAVING COUNT(*) > 1
UNION ALL SELECT 'decisions', code, COUNT(*) FROM decision_items GROUP BY code HAVING COUNT(*) > 1;
