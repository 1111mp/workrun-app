-- Add up migration script here
-- run_records：一次 workflow 或 app 执行一条记录
CREATE TABLE run_records (
  id TEXT PRIMARY KEY NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('workflow', 'app')),
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'failed', 'interrupted')
  ),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  input_json TEXT,
  output_view_json TEXT NOT NULL,
  target_snapshot_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_run_records_target_time
  ON run_records(target_type, target_id, started_at DESC);

CREATE INDEX idx_run_records_started_at
  ON run_records(started_at DESC);

CREATE INDEX idx_run_records_status_time
  ON run_records(status, started_at DESC);

-- run_events：流式事件与日志，按顺序追加
CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

CREATE INDEX idx_run_events_run_sequence
  ON run_events(run_id, sequence);