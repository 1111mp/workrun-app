// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface AskUserQuestionNodeData {
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
  /** {"minItems":1} */
  "options": Array<{
    /** {"description":"Stable identifier used as the React Flow source handle ID.","minLength":1} */
    "id": string;
    /** {"description":"Text presented to the person answering the question."} */
    "label": string;
    "description"?: string;
  }>;
}
