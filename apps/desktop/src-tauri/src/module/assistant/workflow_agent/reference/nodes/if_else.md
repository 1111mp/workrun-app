---
name: workflow-node-if_else
description: Route using two ordered, independent conditions.
---
# Conditional branch (if_else)

true and false are independent conditions, evaluated in that order; if neither matches, execution ends. Supported syntax is a field path tested for truthiness, or compared to one literal with == != >= <= > <. No Python/JavaScript, and/or, calls or arbitrary expressions. Use sourceHandle true/false, with at most one edge per handle; an unconnected result ends. This node records routing and trace, not a business boolean output. Agent/App/CodeAct nodes must create business outputs and publish them with globalKeys.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface IfElseNodeData {
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
  /** {"description":"Conditions evaluated independently for the two outgoing branches."} */
  "conditions": {
    "true": {
      "label": string;
      /** {"minLength":1} */
      "condition": string;
    };
    "false": {
      "label": string;
      /** {"minLength":1} */
      "condition": string;
    };
  };
}
```

## Connections

Allowed source handles: true, false.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "if_else1",
  "type": "if_else",
  "data": {
    "conditions": {
      "true": {
        "label": "Matched",
        "condition": "flag == true"
      },
      "false": {
        "label": "Unmatched",
        "condition": "flag == false"
      }
    }
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
