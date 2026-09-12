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

-- The dispatcher claims queued work by creation time, unlike history views.
CREATE INDEX idx_run_records_queue_claim
  ON run_records(status, created_at ASC, id ASC);

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

-- run_spans is the queryable telemetry projection. Raw content remains in
-- the redacted event journal rather than becoming a second sensitive store.
CREATE TABLE run_spans (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES run_records(id) ON DELETE CASCADE,
  parent_span_id TEXT REFERENCES run_spans(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('workflow_node', 'agent', 'model_call', 'tool_call')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  node_id TEXT,
  node_name TEXT,
  provider TEXT,
  model TEXT,
  tool_name TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  total_tokens_estimated INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens_estimated IN (0, 1)),
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  audio_input_tokens INTEGER,
  audio_output_tokens INTEGER,
  estimated_cost_microusd INTEGER,
  is_byok INTEGER CHECK (is_byok IN (0, 1)),
  error_code TEXT,
  error_message TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_run_spans_run_time
  ON run_spans(run_id, started_at ASC, id ASC);

CREATE INDEX idx_run_spans_parent
  ON run_spans(parent_span_id);

CREATE INDEX idx_run_spans_kind_model
  ON run_spans(kind, provider, model);

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
