// Generated from JSON Schema. Runtime validation remains authoritative.
export interface SwitchNodeData {
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
  "cases"?: Array<{
    /** {"minLength":1} */
    "id": string;
    "label"?: string;
    /** {"minLength":1} */
    "condition": string;
  }>;
  "defaultCase"?: {
    "label"?: string;
    "condition"?: string;
  };
}
