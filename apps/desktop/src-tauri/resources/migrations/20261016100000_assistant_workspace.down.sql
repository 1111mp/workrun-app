-- Drop dependents before the workflow/revision pointer cycle.
DROP TABLE workflow_revision_gc;
DROP TABLE workflow_revision_sessions;
DROP TABLE assistant_session_items;
DROP TABLE assistant_messages;
DROP TRIGGER workflow_revisions_immutable;
DROP TABLE workflows;
DROP TABLE workflow_revisions;
DROP TABLE model_calls;
DROP TABLE assistant_sessions;
