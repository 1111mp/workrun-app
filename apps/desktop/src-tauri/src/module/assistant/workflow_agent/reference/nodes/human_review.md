---
name: workflow-node-human_review
description: Pause for a real human approval or rejection.
---
# Human review (human_review)

Dynamically interrupts execution for a real human decision. contentKey/contextKeys select displayed state; editable allows string edits; attachmentPaths select extra files. sourceHandle is approved/rejected; unconnected outcomes end. Resume through native run-center actions. Never fabricate workflow.human_review.*.approved inputs. editableKey is a legacy field; use contentKey for new workflows.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface HumanReviewNodeData {
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
  "title"?: string;
  /** {"minLength":1} */
  "contentKey"?: string;
  /** {"uniqueItems":true} */
  "contextKeys"?: Array<string>;
  "editable"?: boolean;
  /** {"uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  "editableKey"?: string;
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
    "editable": true
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
