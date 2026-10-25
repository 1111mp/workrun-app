-- Break the deferred pointer cycle before dropping both tables.
DROP TRIGGER workflow_revisions_immutable;

DROP TABLE workflows;

DROP TABLE workflow_revisions;