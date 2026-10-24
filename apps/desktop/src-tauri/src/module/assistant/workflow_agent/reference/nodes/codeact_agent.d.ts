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
  /** {"description":"JSON-serialized object schema; the visual editor stores this field as JSON text."} */
  "outputSchema"?: string;
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
