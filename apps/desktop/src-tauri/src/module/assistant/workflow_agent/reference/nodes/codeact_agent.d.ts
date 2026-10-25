// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface CodeactAgentNodeData {
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
  /** {"description":"Visible node name in the workflow canvas and editor. Set this field when naming or renaming the node."} */
  "name": string;
  /** {"minLength":1} */
  "modelProfileId": string;
  "description": string;
  "instruction": string;
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
  /** {"description":"JSON-serialized object schema; the visual editor stores this field as JSON text."} */
  "outputSchema"?: string;
  /** {"minimum":1,"maximum":50,"default":8} */
  "maxIterations"?: number;
  /** {"minimum":1,"maximum":50,"default":8} */
  "maxToolCalls"?: number;
  /** {"minimum":1,"maximum":600,"default":60} */
  "toolTimeoutSeconds"?: number;
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
