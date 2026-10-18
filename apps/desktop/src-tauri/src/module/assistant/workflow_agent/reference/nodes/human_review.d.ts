// Generated from JSON Schema. Runtime validation remains authoritative.
export interface HumanReviewNodeData {
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
  /** {"minLength":1} */
  "contentKey"?: string;
  /** {"uniqueItems":true} */
  "contextKeys"?: Array<string>;
  "editable"?: boolean;
  /** {"uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  "editableKey"?: string;
}
