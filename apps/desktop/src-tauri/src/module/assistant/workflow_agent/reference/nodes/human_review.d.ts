// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface HumanReviewNodeData {
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
  "title": string;
  "description": string;
  /** {"description":"State key whose value is presented to the reviewer.","minLength":1} */
  "contentKey"?: string;
  /** {"description":"Whether the reviewer may edit the string value before approval."} */
  "editable"?: boolean;
  /** {"description":"Additional read-only state values shown with the review content.","uniqueItems":true} */
  "contextKeys"?: Array<string>;
  /** {"description":"Visible flat State paths selecting additional files for the reviewer.","uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
}
