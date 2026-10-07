-- Remote task tracking is independent of workflow checkpoints. Results fetched
-- here never resume graph execution or change the original run's final state.
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
