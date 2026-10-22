---
name: workflow-node-switch
description: Route to the first matching case or default.
---
# Switch (switch)

Evaluate cases in order and select the first match; otherwise use default. Case IDs must be nonempty and unique. sourceHandle is case:<id> or default, with at most one edge per handle. defaultCase.condition is descriptive only. Conditions use the same limited syntax as if_else. Connect the default branch explicitly.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface SwitchNodeData {
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
  "cases"?: Array<{
    /** {"minLength":1} */
    "id": string;
    "label"?: string;
    /** {"minLength":1} */
    "condition": string;
  }>;
  "defaultCase"?: {
    "label"?: string;
    "condition"?: string;
  };
}
```

## Connections

Allowed source handles: case:<id>, default.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "switch1",
  "type": "switch",
  "data": {
    "cases": [
      {
        "id": "ready",
        "label": "Ready",
        "condition": "status == \"ready\""
      }
    ],
    "defaultCase": {
      "label": "Other",
      "condition": "When no case matches"
    }
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
