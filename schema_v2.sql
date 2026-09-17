-- IMI backend — Wave 0, second slice: persistence for IntelligenceRecord,
-- DecisionItem, and OutcomeItem, completing the Observation/Evidence →
-- Intelligence → Decision → Outcome → Learning chain in real storage.
-- Nested objects (observation, interpretation, options, risks, etc.) are
-- stored as JSON text columns, same pragmatic approach as inbox_items'
-- attachments_json -- not fully normalized, good enough for Wave 0.

CREATE TABLE IF NOT EXISTS intelligence_records (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  domain TEXT NOT NULL,
  record_type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  author TEXT NOT NULL,
  author_role TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  interpretation_json TEXT,
  linked_evidence_json TEXT,
  assumptions_json TEXT,
  open_questions_json TEXT,
  learning_strength TEXT NOT NULL,
  verification_flag TEXT,
  source_category TEXT,
  source_type TEXT,
  evidence_weight TEXT,
  commercial_relevance TEXT,
  verification_status TEXT,
  inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  problem_statement TEXT NOT NULL,
  associated_record_code TEXT NOT NULL,
  approval_class TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'pending',
  approver_required TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  retrospective TEXT NOT NULL,
  options_considered_json TEXT NOT NULL,
  selected_option TEXT NOT NULL,
  rationale TEXT NOT NULL,
  confidence_level TEXT NOT NULL,
  confidence_reason TEXT NOT NULL,
  actions_avoided_json TEXT,
  risks_json TEXT,
  schema_fit_note TEXT,
  inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outcome_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  domain TEXT NOT NULL,
  decision_code TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  actual_outcome TEXT NOT NULL,
  date_evaluated TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  retrospective TEXT NOT NULL,
  quantitative_results_json TEXT,
  qualitative_results_json TEXT,
  attribution_confidence_level TEXT NOT NULL,
  attribution_confidence_reason TEXT NOT NULL,
  unexpected_effects_json TEXT,
  resulting_learning_json TEXT NOT NULL,
  inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_records_status ON intelligence_records(status);
CREATE INDEX IF NOT EXISTS idx_decision_items_approval_status ON decision_items(approval_status);
CREATE INDEX IF NOT EXISTS idx_outcome_items_decision_code ON outcome_items(decision_code);
