---
name: workflow-node-terminate
description: Stop the current workflow and its parents.
---
# Terminate (terminate)

Stops this workflow and all parent workflows, unlike ordinary end. Successors must not continue business execution. Termination does not undo existing side effects; use native compensation and cleanup records.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics remain enforced by validate_workflow_draft. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface TerminateNodeData {
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
}
```

## Connections

No named source handles. Use an ordinary edge only if the node semantics above allow outgoing edges.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "terminate1",
  "type": "terminate",
  "data": {
    "label": "Stop the entire workflow"
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
