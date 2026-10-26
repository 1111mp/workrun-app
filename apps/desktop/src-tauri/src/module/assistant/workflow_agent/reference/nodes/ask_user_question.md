---
name: workflow-node-ask_user_question
description: Pause for the user to select an option.
---
# Ask user (ask_user_question)

Dynamically interrupts execution until the user selects an option. Option IDs must be nonempty and unique. Use sourceHandle option:<id> and connect each option to a destination. Native user actions supply the answer; never answer on the user’s behalf or fabricate workflow.ask_user_question.*.answer.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface AskUserQuestionNodeData {
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
  /** {"minItems":1} */
  "options": Array<{
    /** {"description":"Stable identifier used as the React Flow source handle ID.","minLength":1} */
    "id": string;
    /** {"description":"Text presented to the person answering the question."} */
    "label": string;
    "description"?: string;
  }>;
}
```

## Connections

Allowed source handles: option:<id>.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "ask_user_question1",
  "type": "ask_user_question",
  "data": {
    "title": "Choose an action",
    "options": [
      {
        "id": "continue",
        "label": "Continue"
      },
      {
        "id": "stop",
        "label": "Stop"
      }
    ],
    "description": ""
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
