-- Synthetic data for the isolated STAGING database only. Apply after schema.sql
-- through schema_v9.sql. No real people, customers, enquiries or bookings.
-- Every name is marked SAMPLE. Two brands, so separation can be proven on Cloudflare.
-- Your owner membership is added separately (see the staging guide), never here.

INSERT OR IGNORE INTO workspaces (id, tenant_id, name, kind, description, goal_key, max_headline_words, created_at)
  VALUES ('ws-antardrishti', 'tnt-rama', 'Antardrishti', 'app', 'SAMPLE: Vedic astrology web app.', 'sign_ups', NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'));

INSERT OR IGNORE INTO campaigns (id, code, name, objective, primary_metric, cta_type, destination_url, expected_outcome, created_by, created_at, workspace_id) VALUES
  ('camp-s-iddav', 'CMP-9101', 'SAMPLE Winter safari dates', 'enquiries', 'enquiries', 'whatsapp', 'https://wa.me/910000000000', 'SAMPLE', 'seed', strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'ws-iddav'),
  ('camp-s-ad', 'CMP-9201', 'SAMPLE Couple Chapter Check', 'sign_ups', 'sign_ups', 'website', 'https://example.com', 'SAMPLE', 'seed', strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'ws-antardrishti');

INSERT OR IGNORE INTO contents (id, campaign_id, series_number, template, headline, background_authenticity, status, created_by, created_at, updated_at) VALUES
  ('cnt-s-iddav-1', 'camp-s-iddav', 1, 'bottom', 'SAMPLE Why do tigers walk the forest roads at dawn?', 'original', 'ready', 'seed', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  ('cnt-s-ad-1', 'camp-s-ad', 1, 'bottom', 'SAMPLE ANTARDRISHTI-ONLY timing window post', 'original', 'ready', 'seed', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'));

INSERT OR IGNORE INTO decision_items (id, code, domain, title, problem_statement, associated_record_code, approval_class, approval_status,
  approver_required, retrospective, options_considered_json, selected_option, rationale, confidence_level, confidence_reason, workspace_id) VALUES
  ('dec-s-iddav-1', 'DEC-9101', 'iddav-marketing-intelligence', 'SAMPLE: test a question-led hook on weekday posts', 'SAMPLE', 'REC-9101', 'A', 'pending',
   'Owner', 'none', '[]', 'Run one paired test', 'SAMPLE', 'low', 'Synthetic record for staging tests', 'ws-iddav'),
  ('dec-s-ad-1', 'DEC-9201', 'antardrishti', 'SAMPLE ANTARDRISHTI-ONLY decision', 'SAMPLE', 'REC-9201', 'A', 'pending',
   'Owner', 'none', '[]', 'Wait', 'SAMPLE', 'low', 'Synthetic record for staging tests', 'ws-antardrishti');
