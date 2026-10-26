---
name: workflow-node-switch
description: Route to the first matching case or default.
---
# Switch (switch)

Evaluate cases in order and select the first match; otherwise use default. Case IDs must be nonempty and unique. sourceHandle is case:<id> or default, with at most one edge per handle. defaultCase.condition is descriptive only. Conditions use the same limited syntax as if_else. Connect the default branch explicitly.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface SwitchNodeData {
  "state"?: {
    "access"?: {
      /** {"uniqueItems":true} */
      "readers"?: Array<string>;
      /** {"description":"Readers that may receive this node's original, unredacted namespace.","uniqueItems":true} */
      "rawReaders"?: Array<string>;
    };
    /** {"description":"Keys emitted by this node that should be published to shared global State.","uniqueItems":true} */
    "globalKeys"?: Array<string>;
    /** {"description":"Dot-separated output paths always redacted in this node's visible State.","uniqueItems":true} */
    "sensitiveFields"?: Array<string>;
  };
  "label"?: string;
  "cases": Array<{
    /** {"description":"Stable identifier used as the React Flow source handle ID.","minLength":1} */
    "id": string;
    /** {"description":"Human-readable branch name shown on the canvas."} */
    "label": string;
    /** {"description":"Expression evaluated against workflow state for this branch.","minLength":1} */
    "condition": string;
  }>;
  /** {"description":"Fallback branch used when no case condition matches."} */
  "defaultCase": {
    /** {"description":"Human-readable fallback branch name shown on the canvas."} */
    "label": string;
    /** {"description":"Description of the unmatched cases; this is not evaluated."} */
    "condition": string;
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
