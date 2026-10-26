-- Assistant conversations, workflow definitions and model usage share this baseline.
-- Messages and timeline items are rows; state_json contains current state only.
CREATE TABLE
  assistant_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    state_json TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    active_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

CREATE INDEX assistant_sessions_workspace_updated ON assistant_sessions (workspace_id, updated_at DESC);

CREATE INDEX assistant_sessions_active_run ON assistant_sessions (active_run_id)
WHERE
  active_run_id IS NOT NULL;

CREATE UNIQUE INDEX assistant_sessions_workspace_identity ON assistant_sessions (workspace_id, id);

CREATE TABLE
  assistant_messages (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    turn_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'streaming')),
    message_json TEXT NOT NULL CHECK (json_valid (message_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, session_id, id),
    UNIQUE (workspace_id, session_id, sequence),
    FOREIGN KEY (workspace_id, session_id) REFERENCES assistant_sessions (workspace_id, id) ON DELETE CASCADE
  );

-- Receipts protect referenced runs and support usage queries without scanning JSON.
CREATE INDEX assistant_messages_run ON assistant_messages (run_id)
WHERE
  run_id IS NOT NULL;

CREATE INDEX assistant_messages_turn ON assistant_messages (workspace_id, session_id, turn_id, sequence);

CREATE TABLE
  assistant_session_items (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_id TEXT,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    item_json TEXT NOT NULL CHECK (json_valid (item_json)),
    PRIMARY KEY (workspace_id, session_id, kind, id),
    FOREIGN KEY (workspace_id, session_id) REFERENCES assistant_sessions (workspace_id, id) ON DELETE CASCADE
  );

CREATE INDEX assistant_session_items_turn ON assistant_session_items (workspace_id, session_id, turn_id, kind, sequence);

-- A workflow points at an immutable document; both are published in one transaction.
CREATE TABLE
  workflows (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    current_revision_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (workspace_id, id),
    CHECK (
      deleted_at IS NOT NULL
      OR current_revision_id IS NOT NULL
    ),
    FOREIGN KEY (workspace_id, id, current_revision_id) REFERENCES workflow_revisions (workspace_id, workflow_id, id) DEFERRABLE INITIALLY DEFERRED
  );

CREATE TABLE
  workflow_revisions (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    parent_revision_id TEXT,
    document_json TEXT NOT NULL CHECK (json_valid (document_json)),
    created_at TEXT NOT NULL,
    workflow_created_at TEXT NOT NULL,
    source TEXT NOT NULL,
    operation_id TEXT,
    PRIMARY KEY (workspace_id, id),
    UNIQUE (workspace_id, workflow_id, id),
    UNIQUE (workspace_id, operation_id),
    FOREIGN KEY (workspace_id, workflow_id) REFERENCES workflows (workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (workspace_id, workflow_id, parent_revision_id) REFERENCES workflow_revisions (workspace_id, workflow_id, id) DEFERRABLE INITIALLY DEFERRED
  );

CREATE INDEX workflows_active ON workflows (workspace_id, deleted_at, created_at DESC);

CREATE INDEX workflow_revisions_history ON workflow_revisions (workspace_id, workflow_id, created_at DESC);

CREATE INDEX workflow_revisions_parent ON workflow_revisions (workspace_id, parent_revision_id);

CREATE INDEX workflows_current_revision ON workflows (workspace_id, current_revision_id);

CREATE TABLE
  workflow_revision_sessions (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, session_id, revision_id),
    FOREIGN KEY (workspace_id, session_id) REFERENCES assistant_sessions (workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, revision_id) REFERENCES workflow_revisions (workspace_id, id)
  );

CREATE INDEX workflow_revision_sessions_revision ON workflow_revision_sessions (workspace_id, revision_id);

-- Keep only IDs for versions temporarily retained by current pointers or other
-- conversations, so a later save can reclaim their payload once it is unused.
CREATE TABLE
  workflow_revision_gc (
    workspace_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, revision_id),
    FOREIGN KEY (workspace_id, revision_id) REFERENCES workflow_revisions (workspace_id, id) ON DELETE CASCADE
  );

-- Snapshot contents stay immutable. GC may only detach a deleted parent;
-- comparing two saved versions never requires traversing the parent chain.
CREATE TRIGGER workflow_revisions_immutable BEFORE
UPDATE ON workflow_revisions WHEN NOT (
  OLD.parent_revision_id IS NOT NULL
  AND NEW.parent_revision_id IS NULL
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.id IS OLD.id
  AND NEW.workflow_id IS OLD.workflow_id
  AND NEW.document_json IS OLD.document_json
  AND NEW.created_at IS OLD.created_at
  AND NEW.workflow_created_at IS OLD.workflow_created_at
  AND NEW.source IS OLD.source
  AND NEW.operation_id IS OLD.operation_id
) BEGIN
SELECT
  RAISE (ABORT, 'Workflow revisions are immutable');

END;

-- Calls are independent of session lifetimes; deleting a conversation must not
-- silently change the usage ledger. No prompts or file contents are stored.
CREATE TABLE
  model_calls (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL,
    session_kind TEXT,
    session_id TEXT,
    run_id TEXT,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL
  );

CREATE INDEX model_calls_session ON model_calls (
  workspace_id,
  session_kind,
  session_id,
  started_at
);

CREATE INDEX model_calls_run ON model_calls (workspace_id, run_id);