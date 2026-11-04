-- Scheduling conversations are independent of workflow authoring sessions.
CREATE TABLE schedule_agent_sessions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_schedule_agent_sessions_updated ON schedule_agent_sessions(workspace_id, updated_at DESC);
