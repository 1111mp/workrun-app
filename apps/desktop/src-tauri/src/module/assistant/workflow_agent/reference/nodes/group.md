---
name: workflow-node-group
description: Organize canvas nodes without executing.
---
# Layout group (group)

Canvas layout only; not executable and must have no edges. Children may use React Flow parentId/extent and relative coordinates. Grouping does not create subworkflows or loops.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics remain enforced by validate_workflow_draft. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface GroupNodeData {
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
  "id": "group1",
  "type": "group",
  "data": {
    "label": "Analysis stage"
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
