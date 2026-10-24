---
name: workflow-node-subworkflow
description: Reuse a saved workflow in this workspace.
---
# Subworkflow (subworkflow)

workflowId must identify a saved workflow in the current workspace, not an App, temporary draft or nested nodes/edges document. Inputs are the parent node’s visible state. Only child outputSchema keys are collected; publish them through the parent node’s globalKeys. Direct and indirect recursion are detected. Child reviews/questions use native resume chains. If compensation is declared, only delegated mode is allowed; actual actions live in the child execution journal.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface SubworkflowNodeData {
  "name"?: string;
  "label"?: string;
  "description"?: string;
  "state"?: {
    "access"?: {
      /** {"uniqueItems":true} */
      "readers"?: Array<string>;
      /** {"uniqueItems":true} */
      "rawReaders"?: Array<string>;
    };
    /** {"uniqueItems":true} */
    "globalKeys"?: Array<string>;
    /** {"uniqueItems":true} */
    "sensitiveFields"?: Array<string>;
  };
  /** {"minLength":1} */
  "workflowId": string;
  "workflowName"?: string;
  /** {"description":"Read get_workflow_reference(topic=compensation) for the declaration: mode unspecified/read_only/irreversible/compensatable/delegated; compiler validates nested action, bindings and idempotency."} */
  "compensation"?: {
    [key: string]: unknown;
  };
}
```

## Connections

No named source handles. Use an ordinary edge only if the node semantics above allow outgoing edges.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "subworkflow1",
  "type": "subworkflow",
  "data": {
    "workflowId": "DISCOVER_SAVED_WORKFLOW_ID",
    "compensation": {
      "mode": "delegated"
    }
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
