-- A workflow points at an immutable document; both are published in one transaction.
CREATE TABLE
  workflows (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    current_revision_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (workspace_id, id),
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

CREATE TRIGGER workflow_revisions_immutable BEFORE
UPDATE ON workflow_revisions BEGIN
SELECT
  RAISE (ABORT, 'Workflow revisions are immutable');

END;