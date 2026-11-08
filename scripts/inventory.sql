-- READ-ONLY inventory (no compound SELECTs: Cloudflare D1 limits them).
-- Run each statement with: npx wrangler d1 execute <db> --remote --command "<statement>"
-- or the whole file with --file (read-only, but D1 imports files as a batch).
SELECT (SELECT COUNT(*) FROM inbox_items) AS inbox, (SELECT COUNT(*) FROM intelligence_records) AS records, (SELECT COUNT(*) FROM decision_items) AS decisions, (SELECT COUNT(*) FROM outcome_items) AS outcomes, (SELECT COUNT(*) FROM campaigns) AS campaigns, (SELECT COUNT(*) FROM contents) AS contents, (SELECT COUNT(*) FROM publications) AS publications;
SELECT domain, type AS kind, COUNT(*) AS n FROM inbox_items GROUP BY domain, type;
SELECT domain, record_type AS kind, COUNT(*) AS n FROM intelligence_records GROUP BY domain, record_type;
SELECT domain, approval_status AS kind, COUNT(*) AS n FROM decision_items GROUP BY domain, approval_status;
SELECT source_category, source_type, origin, COUNT(*) AS n FROM inbox_items GROUP BY source_category, source_type, origin ORDER BY n DESC;
SELECT (SELECT MIN(created_at) FROM inbox_items) AS first_inbox, (SELECT MAX(created_at) FROM inbox_items) AS last_inbox, (SELECT COUNT(*) FROM (SELECT code FROM inbox_items GROUP BY code HAVING COUNT(*) > 1)) AS dup_inbox_codes, (SELECT COUNT(*) FROM (SELECT code FROM intelligence_records GROUP BY code HAVING COUNT(*) > 1)) AS dup_record_codes, (SELECT COUNT(*) FROM (SELECT code FROM decision_items GROUP BY code HAVING COUNT(*) > 1)) AS dup_decision_codes;
