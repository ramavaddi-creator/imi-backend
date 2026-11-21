-- Starting topics for Iddav WildStay on STAGING (Rama's parks, 21 Nov 2026). Owners can change them
-- in Intelligence > Search. Safe to run again: existing topics are kept.
INSERT OR IGNORE INTO search_topics (id, workspace_id, label, words_json, sort, created_by, created_at, updated_at)
SELECT t.id, 'ws-iddav', t.label, t.words, t.sort, 'setup', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
FROM (
  SELECT 'st-iddav-tadoba' AS id, 'Tadoba' AS label, '["tadoba","andhari","moharli","kolara","navegaon","chandrapur"]' AS words, 1 AS sort
  UNION ALL SELECT 'st-iddav-pench', 'Pench', '["pench","seoni","turia","khawasa","sillari"]', 2
  UNION ALL SELECT 'st-iddav-kanha', 'Kanha', '["kanha","mukki","khatia","kisli","mandla"]', 3
  UNION ALL SELECT 'st-iddav-bandhavgarh', 'Bandhavgarh', '["bandhavgarh","bandhavgadh","bandavgarh","bandhavgad","umaria"]', 4
  UNION ALL SELECT 'st-iddav-central', 'Central India forests', '["central india","madhya pradesh","satpura","panna","melghat","nagzira","umred","tiger reserve","tiger safari","jungle safari"]', 5
  UNION ALL SELECT 'st-iddav-brand', 'Your own name', '["iddav","sri antra","sriantra","srianthra","shri antra"]', 6
) t
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-iddav');
