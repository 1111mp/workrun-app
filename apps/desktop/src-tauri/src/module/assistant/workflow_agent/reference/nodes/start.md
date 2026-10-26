---
name: workflow-node-start
description: Enter a workflow and expose run inputs.
---
# Start (start)

Exactly one entry is required. It may only connect to executable nodes, cannot be an edge target, and cannot connect directly to end. Each run input key enters global state.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface StartNodeData {
  "label"?: string;
}
```

## Connections

No named source handles. Use an ordinary edge only if the node semantics above allow outgoing edges.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "start1",
  "type": "start",
  "data": {},
  "position": {
    "x": 320,
    "y": 160
  }
}
```
