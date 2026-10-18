// Generated from JSON Schema. Runtime validation remains authoritative.
export interface AskUserQuestionNodeData {
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
  "title"?: string;
  /** {"minItems":1} */
  "options": Array<{
    /** {"minLength":1} */
    "id": string;
    "label"?: string;
    "description"?: string;
  }>;
}
