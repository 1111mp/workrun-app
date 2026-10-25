---
name: workflow-node-human_review
description: Pause for a real human approval or rejection.
---
# Human review (human_review)

Dynamically interrupts execution for a real human decision. contentKey/contextKeys select displayed state; editable allows string edits; attachmentPaths select extra files. sourceHandle is approved/rejected; unconnected outcomes end. Resume through native run-center actions. Never fabricate workflow.human_review.*.approved inputs. editableKey is a legacy field; use contentKey for new workflows.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface HumanReviewNodeData {
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
  "title": string;
  "description": string;
  /** {"description":"State key whose value is presented to the reviewer.","minLength":1} */
  "contentKey"?: string;
  /** {"description":"Whether the reviewer may edit the string value before approval."} */
  "editable"?: boolean;
  /** {"description":"Additional read-only state values shown with the review content.","uniqueItems":true} */
  "contextKeys"?: Array<string>;
  /** {"description":"Visible flat State paths selecting additional files for the reviewer.","uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
}
```

## Connections

Allowed source handles: approved, rejected.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "human_review1",
  "type": "human_review",
  "data": {
    "title": "Review the result",
    "contentKey": "summary",
    "editable": true,
    "description": ""
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
