-- Synthetic data for the isolated staging database only. No real people,
-- customers, enquiries or bookings. Every name is marked SAMPLE.
INSERT OR IGNORE INTO decision_items (id, code, domain, title, problem_statement, associated_record_code, approval_class, approval_status,
  approver_required, retrospective, options_considered_json, selected_option, rationale, confidence_level, confidence_reason)
VALUES
 ('dec-sample-1', 'DEC-9001', 'iddav-marketing-intelligence', 'SAMPLE: test a question-led hook on weekday posts', 'SAMPLE problem', 'REC-9001', 'A', 'pending',
  'Owner', 'none', '[]', 'Run one paired test', 'SAMPLE rationale', 'low', 'Synthetic record for staging tests'),
 ('dec-sample-2', 'DEC-9002', 'iddav-marketing-intelligence', 'SAMPLE: pause carousel format for two weeks', 'SAMPLE problem', 'REC-9002', 'B', 'pending',
  'Owner', 'none', '[]', 'Pause and compare', 'SAMPLE rationale', 'low', 'Synthetic record for staging tests');
