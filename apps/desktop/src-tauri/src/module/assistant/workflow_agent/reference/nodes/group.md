---
name: workflow-node-group
description: Organize canvas nodes without executing.
---
# Layout group (group)

Canvas layout only; not executable and must have no edges. Children may use React Flow parentId/extent and relative coordinates. Grouping does not create subworkflows or loops.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface GroupNodeData {
  /** {"description":"Human-readable title shown in the group header."} */
  "label"?: string;
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
