// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface IfElseNodeData {
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
  "label"?: string;
  /** {"description":"Conditions evaluated independently for the two outgoing branches."} */
  "conditions": {
    "true": {
      "label": string;
      /** {"minLength":1} */
      "condition": string;
    };
    "false": {
      "label": string;
      /** {"minLength":1} */
      "condition": string;
    };
  };
}
