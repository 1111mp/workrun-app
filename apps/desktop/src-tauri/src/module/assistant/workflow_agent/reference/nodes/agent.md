---
name: workflow-node-agent
description: Use a configured model, tools and personal skills.
---
# Local agent (agent)

Reads visible scoped state; instruction defines its task. outputKey stores the complete final text and is mutually exclusive with outputSchema. Structured output top-level keys are private until published with state.globalKeys. Discover real toolIds; the executor enforces Tool App confirmation. skillRefs must reference existing personal skills. attachmentPaths select visible state paths. Omitted temperature/topP use runtime defaults. maxToolCalls: 1–50, default 8; toolTimeoutSeconds: 1–600, default 60.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics remain enforced by validate_workflow_draft. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface AgentNodeData {
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
  /** {"minLength":1} */
  "modelProfileId": string;
  "instruction"?: string;
  "outputSchema"?: string | {
    [key: string]: unknown;
  };
  /** {"uniqueItems":true} */
  "toolIds"?: Array<string>;
  "toolStateBindings"?: Array<{
    /** {"minLength":1} */
    "toolId": string;
    /** {"minLength":1} */
    "argumentPath": string;
    /** {"minLength":1} */
    "statePath": string;
  }>;
  /** {"minimum":1,"maximum":50,"default":8} */
  "maxToolCalls"?: number;
  /** {"minimum":1,"maximum":600,"default":60} */
  "toolTimeoutSeconds"?: number;
  /** {"minLength":1} */
  "outputKey"?: string;
  /** {"minimum":0,"maximum":2} */
  "temperature"?: number;
  /** {"minimum":0,"maximum":1} */
  "topP"?: number;
  /** {"uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  "skillRefs"?: Array<{
    "source": "personal";
    /** {"minLength":1} */
    "name": string;
  }>;
  "toolCompensations"?: {
    [key: string]: {
      [key: string]: unknown;
    };
  };
}
```

## Connections

No named source handles. Use an ordinary edge only if the node semantics above allow outgoing edges.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "agent1",
  "type": "agent",
  "data": {
    "modelProfileId": "DISCOVER_MODEL_ID",
    "instruction": "Analyze visible inputs and return structured findings.",
    "outputSchema": {
      "type": "object",
      "properties": {
        "summary": {
          "type": "string"
        }
      },
      "required": [
        "summary"
      ]
    },
    "state": {
      "globalKeys": [
        "summary"
      ]
    }
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
