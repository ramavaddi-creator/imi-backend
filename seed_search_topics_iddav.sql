-- Starting topics for Iddav WildStay on STAGING (Rama's parks, 21 Nov 2026). Owners can change them
-- in Intelligence > Search. Safe to run again: existing topics are kept.
-- One statement per topic (Cloudflare D1 refuses long UNION ALL lists).
INSERT OR IGNORE INTO search_topics (id, workspace_id, label, words_json, sort, created_by, created_at, updated_at)
  SELECT 'st-iddav-tadoba', 'ws-iddav', 'Tadoba', '["tadoba","andhari","moharli","kolara","navegaon","chandrapur"]', 1, 'setup', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-iddav');
INSERT OR IGNORE INTO search_topics (id, workspace_id, label, words_json, sort, created_by, created_at, updated_at)
  SELECT 'st-iddav-pench', 'ws-iddav', 'Pench', '["pench","seoni","turia","khawasa","sillari"]', 2, 'setup', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-iddav');
INSERT OR IGNORE INTO search_topics (id, workspace_id, label, words_json, sort, created_by, created_at, updated_at)
  SELECT 'st-iddav-kanha', 'ws-iddav', 'Kanha', '["kanha","mukki","khatia","kisli","mandla"]', 3, 'setup', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-iddav');
INSERT OR IGNORE INTO search_topics (id, workspace_id, label, words_json, sort, created_by, created_at, updated_at)
  SELECT 'st-iddav-bandhavgarh', 'ws-iddav', 'Bandhavgarh', '["bandhavgarh","bandhavgadh","bandavgarh","bandhavgad","umaria"]', 4, 'setup', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-iddav');
INSERT OR IGNORE INTO search_topics (id, workspace_id, label, words_json, sort, created_by, created_at, updated_at)
  SELECT 'st-iddav-central', 'ws-iddav', 'Central India forests', '["central india","madhya pradesh","satpura","panna","melghat","nagzira","umred","tiger reserve","tiger safari","jungle safari"]', 5, 'setup', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-iddav');
INSERT OR IGNORE INTO search_topics (id, workspace_id, label, words_json, sort, created_by, created_at, updated_at)
  SELECT 'st-iddav-brand', 'ws-iddav', 'Your own name', '["iddav","sri antra","sriantra","srianthra","shri antra"]', 6, 'setup', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'ws-iddav');
