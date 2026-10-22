---
name: workflow-node-remote_agent
description: Call a configured remote A2A agent.
---
# Remote agent (remote_agent)

Uses A2A v1.0.1 JSON-RPC. HTTP(S) URLs must not contain user information or fragments. authentication references existing credential IDs; never embed secrets. Attachments select visible state paths, at most 10 files and 20 MiB total; binary content stays outside state. timeoutSeconds: 1–600, default 120. Timeout does not prove absence of remote side effects: use native task inspection, cancellation and recovery rather than blindly retrying.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface RemoteAgentNodeData {
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
  "url": string;
  /** {"minimum":1,"maximum":600,"default":120} */
  "timeoutSeconds"?: number;
  /** {"uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  "authentication"?: {
    "type": "none" | "bearer" | "apiKey";
    /** {"minLength":1} */
    "credentialId"?: string;
    /** {"minLength":1} */
    "headerName"?: string;
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
  "id": "remote_agent1",
  "type": "remote_agent",
  "data": {
    "url": "https://example.invalid/a2a",
    "timeoutSeconds": 120,
    "authentication": {
      "type": "none"
    }
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
