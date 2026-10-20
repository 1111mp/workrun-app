---
name: workflow-node-process
description: Execute an installed Workflow-type App.
---
# Workflow App (process)

Uses the existing Process executor for installed Workflow-type Apps. Tool-type Apps belong in agent.toolIds; never change their type to bypass confirmation. processNodeId is the native local App ID, without the app: capability prefix. The App receives visible inputs; outputs remain private until their agreed keys are published. Team appRef requires immutable coordinates for an authorized published version; ask for missing coordinates. Do not substitute inline scripts for Apps. Read the recovery topic for compensation.

Discover the App contract before configuration: process receives scoped visible state, so its expected input keys must be available under the names its contract declares. Node edges do not rename fields. For tool-shaped calls inside an Agent, select a Tool App or MCP tool in toolIds instead. Publish only actual declared outputs through state.globalKeys. Read reference topic=configuration and topic=examples with node_types=["process"] for a native example.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics remain enforced by validate_workflow_draft. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface ProcessNodeData {
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
  "processNodeId": string;
  "appRef"?: {
    [key: string]: unknown;
  };
  /** {"description":"Read get_workflow_reference(topic=compensation) for the declaration: mode unspecified/read_only/irreversible/compensatable/delegated; compiler validates nested action, bindings and idempotency."} */
  "compensation"?: {
    [key: string]: unknown;
  };
}
```

## Connections

No named source handles. Use an ordinary edge only if the node semantics above allow outgoing edges.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "process1",
  "type": "process",
  "data": {
    "processNodeId": "DISCOVER_LOCAL_APP_ID",
    "state": {
      "globalKeys": [
        "result"
      ]
    }
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
