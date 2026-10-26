// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface SwitchNodeData {
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
  "cases": Array<{
    /** {"description":"Stable identifier used as the React Flow source handle ID.","minLength":1} */
    "id": string;
    /** {"description":"Human-readable branch name shown on the canvas."} */
    "label": string;
    /** {"description":"Expression evaluated against workflow state for this branch.","minLength":1} */
    "condition": string;
  }>;
  /** {"description":"Fallback branch used when no case condition matches."} */
  "defaultCase": {
    /** {"description":"Human-readable fallback branch name shown on the canvas."} */
    "label": string;
    /** {"description":"Description of the unmatched cases; this is not evaluated."} */
    "condition": string;
  };
}
