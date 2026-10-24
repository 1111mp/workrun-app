CREATE TABLE
  assistant_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    session_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE INDEX assistant_sessions_workspace_updated ON assistant_sessions (workspace_id, updated_at DESC);