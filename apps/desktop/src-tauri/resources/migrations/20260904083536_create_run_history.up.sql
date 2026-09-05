-- Add up migration script here
-- run_records：一次 workflow 或 app 执行一条记录。事件日志才是事实来源，
-- output_view_json 仅保留为打开历史记录时的投影缓存。
CREATE TABLE run_records (
  id TEXT PRIMARY KEY NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('workflow', 'app')),
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'running', 'waiting_for_input',
      'completed', 'failed', 'cancelled', 'interrupted'
    )
  ),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  input_json TEXT,
  output_view_json TEXT NOT NULL DEFAULT '{}',
  target_snapshot_json TEXT NOT NULL,
  runtime_json TEXT NOT NULL DEFAULT '{}',
  last_sequence INTEGER NOT NULL DEFAULT -1,
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

CREATE INDEX idx_run_records_started_at_id
  ON run_records(started_at DESC, id DESC);

CREATE INDEX idx_run_records_target_started_at_id
  ON run_records(target_type, target_id, started_at DESC, id DESC);

CREATE INDEX idx_run_records_status_started_at_id
  ON run_records(status, started_at DESC, id DESC);

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

-- A pending action is separate from the run status: many runs may wait at
-- once, while the UI chooses only one action to present at a time.
CREATE TABLE run_pending_actions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('tool_approval', 'human_review', 'ask_user_question')
  ),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'resolved', 'cancelled', 'expired')
  ),
  -- A claim is a temporary UI ownership lease, not a terminal state.
  claimed_by TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_json TEXT
);

CREATE INDEX idx_run_pending_actions_status_created
  ON run_pending_actions(status, created_at ASC);

CREATE INDEX idx_run_pending_actions_claim
  ON run_pending_actions(status, claimed_by, created_at ASC, id ASC);
