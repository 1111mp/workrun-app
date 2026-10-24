---
name: workflow-node-end
description: Complete a workflow branch.
---
# End (end)

At least one end node is required. End nodes only accept incoming edges; all map to graph END. Declaring outputSchema does not create output: executable nodes must publish output keys to global state.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface EndNodeData {
  "name"?: string;
  "label"?: string;
  "description"?: string;
}
```

## Connections

No named source handles. Use an ordinary edge only if the node semantics above allow outgoing edges.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "end1",
  "type": "end",
  "data": {},
  "position": {
    "x": 320,
    "y": 160
  }
}
```
