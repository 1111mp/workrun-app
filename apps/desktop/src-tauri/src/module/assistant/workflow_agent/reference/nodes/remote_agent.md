---
name: workflow-node-remote_agent
description: Call a configured remote A2A agent.
---
# Remote agent (remote_agent)

Uses A2A v1.0.1 JSON-RPC. HTTP(S) URLs must not contain user information or fragments. authentication references existing credential IDs; never embed secrets. Attachments select visible state paths, at most 10 files and 20 MiB total; binary content stays outside state. timeoutSeconds: 1–600, default 120. Timeout does not prove absence of remote side effects: use native task inspection, cancellation and recovery rather than blindly retrying.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface RemoteAgentNodeData {
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
  "authentication"?: {
    "type": "none";
  } | {
    "type": "bearer";
    /** {"minLength":1} */
    "credentialId": string;
  } | {
    "type": "apiKey";
    /** {"minLength":1} */
    "credentialId": string;
    /** {"minLength":1} */
    "headerName": string;
  };
  /** {"uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  /** {"minimum":1,"maximum":600,"default":120} */
  "timeoutSeconds"?: number;
  "name": string;
  /** {"minLength":1} */
  "url": string;
  "description": string;
}
```

## Connections

No named source handles. Use an ordinary edge only if the node semantics above allow outgoing edges.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "remote_agent1",
  "type": "remote_agent",
  "data": {
    "url": "https://example.invalid/a2a",
    "timeoutSeconds": 120,
    "authentication": {
      "type": "none"
    },
    "name": "Remote agent",
    "description": ""
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
