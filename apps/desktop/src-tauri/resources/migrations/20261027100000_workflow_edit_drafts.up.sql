-- Each row holds one personal editing copy. Metadata remains queryable columns;
-- document_json is one workflow document, never a collection of draft records.
CREATE TABLE workflow_edit_drafts (
  workspace_id TEXT NOT NULL CHECK (workspace_id = 'personal'),
  draft_key TEXT NOT NULL,
  workflow_id TEXT,
  -- A comparison token, not a retention pin: old revisions may be collected.
  base_revision_id TEXT,
  document_json TEXT NOT NULL CHECK (
    json_valid(document_json)
    AND json_type(document_json) IS 'object'
    AND json_type(document_json, '$.nodes') IS 'array'
    AND json_type(document_json, '$.edges') IS 'array'
    AND json_type(document_json, '$.settings') IS 'object'
  ),
  saved_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, draft_key),
  CHECK (draft_key = COALESCE(workflow_id, 'new')),
  CHECK (workflow_id IS NOT NULL OR base_revision_id IS NULL),
  FOREIGN KEY (workspace_id, workflow_id) REFERENCES workflows (workspace_id, id) ON DELETE CASCADE
);

-- Workflows use soft deletion, so a foreign-key cascade alone is insufficient.
CREATE TRIGGER workflow_edit_drafts_delete_with_workflow
AFTER UPDATE OF deleted_at ON workflows
WHEN NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM workflow_edit_drafts WHERE workspace_id = NEW.workspace_id AND draft_key = NEW.id;
END;
