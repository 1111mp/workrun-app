---
name: workflow-node-codeact_agent
description: Compose authorized tools with restricted Python.
---
# CodeAct agent (codeact_agent)

Uses the restricted Monty Python runtime, not an unrestricted Python terminal or package installer. Read input files through /artifacts/manifest.json; write deliverables under /outputs for runtime export. maxIterations: 1–50, default 8; script duration: 1–300 seconds, default 5; memory: 16–4096 MiB, default 256. mounts/environment grant real host access and must come from explicitly authorized configuration. Never invent paths or secrets. Reserve /artifacts and /outputs; mounts must not overlap. Compilation currently requires a configured model and workspace runtime. The artifact manifest is an array of {reference:{id,name,...},path}; read entry.path, not a guessed input-name key or artifact directory. Inspect input structure before processing. Finish with a last-expression {"type":"final_result","value":{...named output fields...}}. Object fields enter private state and state.globalKeys publishes them; use outputSchema for explicit validation. Do not invent global-state tools. Avoid bound dictionary methods as callbacks in Monty; use explicit loops.

CodeAct selects executable dependencies with discovered toolIds and may bind arguments with toolStateBindings. It does not support personal skillRefs or Agent outputKey/attachmentPaths. Visible ArtifactRefs are mapped to its file workspace automatically. Workrun writes exported files to the artifacts state key; publish artifacts with state.globalKeys or share the namespace through readers when downstream nodes need them. Do not put invented ArtifactRefs into final_result. Read reference topic=configuration and topic=examples with node_types=["codeact_agent"] for a native example.

## Configuration

TypeScript is a readable projection of the node data schema, not executable configuration. Numeric limits, uniqueness, additional-property rules and native semantics remain enforced by validate_workflow_draft. Request topic=node-schema with this node type only when the exact JSON Schema is needed.

```typescript
// Generated from JSON Schema. Runtime validation remains authoritative.
export interface CodeactAgentNodeData {
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
  /** {"minimum":1,"maximum":50,"default":8} */
  "maxIterations"?: number;
  /** {"minimum":1,"maximum":300,"default":5} */
  "maxScriptDurationSeconds"?: number;
  /** {"minimum":16,"maximum":4096,"default":256} */
  "maxScriptMemoryMiB"?: number;
  /** {"default":true} */
  "systemClock"?: boolean;
  "mounts"?: Array<{
    /** {"minLength":1} */
    "virtualPath": string;
    /** {"minLength":1} */
    "hostPath": string;
    "access": "read_only" | "read_write";
  }>;
  "environment"?: Array<{
    /** {"minLength":1} */
    "name": string;
    "value": string;
  }>;
}
```

## Connections

No named source handles. Use an ordinary edge only if the node semantics above allow outgoing edges.

## Example node

Replace discovery placeholders with real resource IDs before validation.

```json
{
  "id": "codeact_agent1",
  "type": "codeact_agent",
  "data": {
    "modelProfileId": "DISCOVER_MODEL_ID",
    "instruction": "Read inputs from authorized resources, calculate results and write files to /outputs.",
    "maxIterations": 8
  },
  "position": {
    "x": 320,
    "y": 160
  }
}
```
