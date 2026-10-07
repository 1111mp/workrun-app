-- Adapter facts and operation attempts are durable independently of checkpoints.
CREATE TABLE remote_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  service_origin TEXT NOT NULL,
  connection_ciphertext TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_known_state TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT
);
CREATE INDEX idx_remote_tasks_run ON remote_tasks(run_id, created_at, id);

-- Operations are business facts; checkpoints only describe graph progress.
CREATE TABLE workflow_operations (
 id TEXT PRIMARY KEY NOT NULL,
 execution_id TEXT NOT NULL,
 execution_path TEXT NOT NULL,
 adapter TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 snapshot_digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','unknown')),
 adapter_record_id TEXT UNIQUE,
 result_json TEXT,
 dispatched_at TEXT,
 last_error_retryable INTEGER,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 compensation_required INTEGER NOT NULL DEFAULT 0,
 purpose TEXT NOT NULL DEFAULT 'execution' CHECK(purpose IN ('execution','compensation')),
 dependencies_recorded INTEGER NOT NULL DEFAULT 0,
 confirmed_no_effect INTEGER NOT NULL DEFAULT 0,
 approval_required INTEGER NOT NULL DEFAULT 0,
 UNIQUE(execution_id, execution_path)
);
CREATE TABLE workflow_operation_attempts (
 id TEXT PRIMARY KEY NOT NULL,
 operation_id TEXT NOT NULL REFERENCES workflow_operations(id),
 run_id TEXT NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('submit','reconcile','reuse')),
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','unknown')),
 error_summary TEXT,
 started_at TEXT NOT NULL,
 ended_at TEXT,
 UNIQUE(operation_id, sequence)
);
CREATE INDEX idx_operation_attempt_run ON workflow_operation_attempts(run_id);

CREATE TABLE run_attempts (
 id TEXT PRIMARY KEY NOT NULL,
 run_id TEXT NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL,
 status TEXT NOT NULL,
 started_at TEXT NOT NULL,
 ended_at TEXT,
 error TEXT,
 output_view_json TEXT,
 UNIQUE(run_id, sequence)
);
INSERT INTO run_attempts (id, run_id, sequence, status, started_at, ended_at, error, output_view_json)
 SELECT id || ':original', id, 1, status, started_at, ended_at, error, output_view_json
 FROM run_records WHERE status != 'queued';
CREATE TABLE run_recovery_jobs (
 run_id TEXT PRIMARY KEY NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','running','blocked','done')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_check_at TEXT NOT NULL,
 last_error TEXT,
 updated_at TEXT NOT NULL
);

-- Raw bound arguments stay private; the common journal holds only digests and encrypted result envelopes.
CREATE TABLE workflow_tool_inputs (
    operation_id TEXT PRIMARY KEY REFERENCES workflow_operations(id) ON DELETE CASCADE,
    input_ciphertext TEXT NOT NULL
);

CREATE TABLE workflow_process_inputs (
    operation_id TEXT PRIMARY KEY REFERENCES workflow_operations(id) ON DELETE CASCADE,
    input_ciphertext TEXT NOT NULL
);

-- One child checkpoint namespace per logical parent invocation.
CREATE TABLE workflow_subworkflow_invocations (
    operation_id TEXT PRIMARY KEY REFERENCES workflow_operations(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL UNIQUE,
    snapshot_ciphertext TEXT NOT NULL
);

-- Compensation state is separate from execution state. No intent is scheduled on failure alone.
CREATE TABLE workflow_compensation_intents (
 id TEXT PRIMARY KEY NOT NULL,
 operation_id TEXT NOT NULL UNIQUE REFERENCES workflow_operations(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('unspecified','read_only','compensatable','irreversible','delegated')),
 status TEXT NOT NULL DEFAULT 'not_requested' CHECK(status IN ('not_requested','pending','running','succeeded','failed','blocked')),
 provenance TEXT NOT NULL CHECK(provenance IN ('before_dispatch','after_dispatch')),
 declaration_digest TEXT NOT NULL,
 context_ciphertext TEXT NOT NULL,
 outcome_ciphertext TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 last_error TEXT
);
CREATE TABLE workflow_compensation_events (
 id TEXT PRIMARY KEY NOT NULL,
 intent_id TEXT NOT NULL REFERENCES workflow_compensation_intents(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('intent_recorded','outcome_recorded')),
 created_at TEXT NOT NULL,
 UNIQUE(intent_id, sequence)
);

CREATE TABLE workflow_operation_dependencies (
 operation_id TEXT NOT NULL REFERENCES workflow_operations(id) ON DELETE CASCADE,
 predecessor_id TEXT NOT NULL REFERENCES workflow_operations(id) ON DELETE CASCADE,
 PRIMARY KEY(operation_id,predecessor_id),
 CHECK(operation_id != predecessor_id)
);
CREATE TABLE workflow_abandonments (
 run_id TEXT PRIMARY KEY NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','running','completed','blocked')),
 requested_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 next_check_at TEXT NOT NULL,
 last_error TEXT
);

CREATE TABLE workflow_operation_reviews (
 id TEXT PRIMARY KEY NOT NULL,
 operation_id TEXT NOT NULL REFERENCES workflow_operations(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
 attempt_sequence INTEGER NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('completed','no_effect')),
 evidence_ciphertext TEXT NOT NULL,
 remote_record_id TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(operation_id,attempt_sequence)
);
CREATE TABLE workflow_compensation_approvals (
 id TEXT PRIMARY KEY NOT NULL,
 operation_id TEXT NOT NULL REFERENCES workflow_operations(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','granted','denied','consumed')),
 target_name TEXT NOT NULL,
 arguments_ciphertext TEXT NOT NULL,
 created_at TEXT NOT NULL,
 resolved_at TEXT,
 consumed_at TEXT
);
CREATE UNIQUE INDEX idx_compensation_active_approval ON workflow_compensation_approvals(operation_id) WHERE status IN ('pending','granted');
