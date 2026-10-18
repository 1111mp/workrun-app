---
name: workflow-node-ask_user_question
description: Pause for the user to select an option.
---
# Ask user (ask_user_question)

Dynamically interrupts execution until the user selects an option. Option IDs must be nonempty and unique. Use sourceHandle option:<id> and connect each option to a destination. Native user actions supply the answer; never answer on the user’s behalf or fabricate workflow.ask_user_question.*.answer.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics remain enforced by validate_workflow_draft. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface AskUserQuestionNodeData {
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
  /** {"minItems":1} */
  "options": Array<{
    /** {"minLength":1} */
    "id": string;
    "label"?: string;
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
    ]
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
