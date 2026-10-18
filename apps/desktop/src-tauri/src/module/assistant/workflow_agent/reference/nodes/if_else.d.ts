// Generated from JSON Schema. Runtime validation remains authoritative.
export interface IfElseNodeData {
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
  "conditions": {
    "true": {
      "label"?: string;
      /** {"minLength":1} */
      "condition": string;
    };
    "false": {
      "label"?: string;
      /** {"minLength":1} */
      "condition": string;
    };
  };
}
