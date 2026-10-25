---
name: workflow-node-process
description: Execute an installed Workflow-type App.
---
# Workflow App (process)

Uses the existing Process executor for installed Workflow-type Apps. Tool-type Apps belong in agent.toolIds; never change their type to bypass confirmation. processNodeId is the native local App ID, without the app: capability prefix. The App receives visible inputs; outputs remain private until their agreed keys are published. Team appRef requires immutable coordinates for an authorized published version; ask for missing coordinates. Do not substitute inline scripts for Apps. Read the recovery topic for compensation.

Discover the App contract before configuration: process receives scoped visible state, so its expected input keys must be available under the names its contract declares. Node edges do not rename fields. For tool-shaped calls inside an Agent, select a Tool App or MCP tool in toolIds instead. Publish only actual declared outputs through state.globalKeys. Read reference topic=configuration and topic=examples with node_types=["process"] for a native example.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface ProcessNodeData {
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
  /** {"description":"Read get_workflow_reference(topic=compensation) for the declaration: mode unspecified/read_only/irreversible/compensatable/delegated; compiler validates nested action, bindings and idempotency."} */
  "compensation"?: {
    "mode": "unspecified" | "read_only";
  } | {
    "mode": "irreversible";
    "reason": string;
  } | {
    "mode": "compensatable";
    "action": {
      "kind": "app_entry";
    } | {
      "kind": "tool";
      "toolId": string;
    } | {
      "kind": "process";
      "processNodeId": string;
    } | {
      "kind": "remote_agent";
      "url": string;
      "authentication"?: {
        "type": "none";
      } | {
        "type": "bearer";
        "credentialId": string;
      } | {
        "type": "apiKey";
        "credentialId": string;
        "headerName": string;
      };
    };
    "bindings": {
      [key: string]: {
        "from": "literal";
        "value": unknown;
      } | {
        "from": "input" | "output";
        "pointer": string;
      };
    };
    "idempotency": {
      "keyArgument": string;
      "contract": string;
    };
  };
  "name": string;
  /** {"minLength":1} */
  "processNodeId": string;
  "description": string;
  /** {"description":"Local Apps use a local ID; Team Apps pin an immutable server release."} */
  "appRef"?: {
    "source": "local";
    "localAppId": string;
    "appName"?: string;
    "version"?: string;
    "sourceHash"?: string;
  } | {
    "source": "team";
    "remoteAppId": string;
    "releaseId": string;
    "appName"?: string;
    "version": string;
    "archiveSha256": string;
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
    },
    "name": "Workflow App",
    "description": ""
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
