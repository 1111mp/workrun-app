---
name: workflow-node-agent
description: Use a configured model, tools and personal skills.
---
# Local agent (agent)

Reads visible scoped state; instruction defines its task. outputKey stores the complete final text and is mutually exclusive with outputSchema. Structured output top-level keys are private until published with state.globalKeys. Discover real toolIds; the executor enforces Tool App confirmation. skillRefs must reference existing personal skills. attachmentPaths select visible state paths containing ArtifactRefs (files), never ordinary text, JSON strings or objects. Visible ordinary values are already available as scoped state; refer to their existing keys in instruction and use native state visibility. Do not add attachmentPaths merely to pass a previous node result. UTF-8 text/*, JSON and XML attachments are included as file text (1 MiB per file); images use provider-native attachments, and PDF attachments require Gemini. Other binary formats require extraction before analysis. Total attachments are limited to 20 MiB. Omitted temperature/topP use runtime defaults. maxToolCalls: 1–50, default 8; toolTimeoutSeconds: 1–600, default 60.

Tool IDs and callable names are different: select the discovered ID in toolIds and toolStateBindings.toolId; use the tool contract for its callable name and argument schema. With no selected Skills, selected tools are attached directly. With skillRefs, SkillToolset exposes Skill discovery/loading and resolves tools after the declaring Skill is loaded. Every Skill-declared tool must be selected; nonempty allowedTools declarations restrict the effective tool set to their union. Reading a Skill during planning does not activate it in this node. Read reference topic=configuration for resource wiring and topic=examples with node_types=["agent"] for a native example.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics are validated by save_workflow_draft before writing. Use validate_workflow_draft separately only for a validation-only review. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface AgentNodeData {
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
  /** {"description":"Per-tool compensation declarations; CodeAct effects have no compensation journal."} */
  "toolCompensations"?: {
    [key: string]: {
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
  };
  /** {"description":"Visible node name in the workflow canvas and editor. Set this field when naming or renaming the node."} */
  "name": string;
  /** {"minLength":1} */
  "modelProfileId": string;
  /** {"description":"Visible State paths containing ArtifactRefs, injected as model attachments.","uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  "description": string;
  "instruction": string;
  /** {"description":"Optional state key that receives the agent's complete final text.","minLength":1} */
  "outputKey"?: string;
  /** {"description":"JSON-serialized object schema; the visual editor stores this field as JSON text."} */
  "outputSchema"?: string;
  /** {"minimum":0,"maximum":2} */
  "temperature"?: number;
  /** {"minimum":0,"maximum":1} */
  "topP"?: number;
  "skillRefs"?: Array<{
    "source": "personal";
    /** {"minLength":1} */
    "name": string;
  }>;
  /** {"uniqueItems":true} */
  "toolIds"?: Array<string>;
  "toolStateBindings"?: Array<{
    /** {"minLength":1} */
    "toolId": string;
    /** {"description":"Dot-separated path in the Tool's arguments.","minLength":1} */
    "argumentPath": string;
    /** {"description":"Dot-separated path in the Agent's scoped State.","minLength":1} */
    "statePath": string;
  }>;
  /** {"minimum":1,"maximum":50,"default":8} */
  "maxToolCalls"?: number;
  /** {"minimum":1,"maximum":600,"default":60} */
  "toolTimeoutSeconds"?: number;
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
    "outputSchema": "{\"type\":\"object\",\"properties\":{\"summary\":{\"type\":\"string\"}},\"required\":[\"summary\"]}",
    "state": {
      "globalKeys": [
        "summary"
      ]
    },
    "name": "Local agent",
    "description": ""
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
