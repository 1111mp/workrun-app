// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface RemoteAgentNodeData {
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
  /** {"description":"Read get_workflow_reference(topic=compensation) for the declaration: mode unspecified/read_only/irreversible/compensatable/delegated; compiler validates nested action, bindings and idempotency."} */
  "compensation"?: {
    "mode": "unspecified" | "read_only";
  } | {
    "mode": "irreversible";
    "reason": string;
  } | {
    "mode": "compensatable";
    "action": {
      "kind": "app_entry";
    } | {
      "kind": "tool";
      "toolId": string;
    } | {
      "kind": "process";
      "processNodeId": string;
    } | {
      "kind": "remote_agent";
      "url": string;
      "authentication"?: {
        "type": "none";
      } | {
        "type": "bearer";
        "credentialId": string;
      } | {
        "type": "apiKey";
        "credentialId": string;
        "headerName": string;
      };
    };
    "bindings": {
      [key: string]: {
        "from": "literal";
        "value": unknown;
      } | {
        "from": "input" | "output";
        "pointer": string;
      };
    };
    "idempotency": {
      "keyArgument": string;
      "contract": string;
    };
  };
  "authentication"?: {
    "type": "none";
  } | {
    "type": "bearer";
    /** {"minLength":1} */
    "credentialId": string;
  } | {
    "type": "apiKey";
    /** {"minLength":1} */
    "credentialId": string;
    /** {"minLength":1} */
    "headerName": string;
  };
  /** {"uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  /** {"minimum":1,"maximum":600,"default":120} */
  "timeoutSeconds"?: number;
  "name": string;
  /** {"minLength":1} */
  "url": string;
  "description": string;
}
