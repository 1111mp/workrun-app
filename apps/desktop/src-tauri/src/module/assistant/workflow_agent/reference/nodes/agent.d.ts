// Generated from editor workflow.d.ts and runtime constraints; do not edit.
export interface AgentNodeData {
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
  /** {"description":"Per-tool compensation declarations; CodeAct effects have no compensation journal."} */
  "toolCompensations"?: {
    [key: string]: {
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
  };
  /** {"description":"Visible node name in the workflow canvas and editor. Set this field when naming or renaming the node."} */
  "name": string;
  /** {"minLength":1} */
  "modelProfileId": string;
  /** {"description":"Visible State paths containing ArtifactRefs, injected as model attachments.","uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  "description": string;
  "instruction": string;
  /** {"description":"Optional state key that receives the agent's complete final text.","minLength":1} */
  "outputKey"?: string;
  /** {"description":"JSON-serialized object schema; the visual editor stores this field as JSON text."} */
  "outputSchema"?: string;
  /** {"minimum":0,"maximum":2} */
  "temperature"?: number;
  /** {"minimum":0,"maximum":1} */
  "topP"?: number;
  "skillRefs"?: Array<{
    "source": "personal";
    /** {"minLength":1} */
    "name": string;
  }>;
  /** {"uniqueItems":true} */
  "toolIds"?: Array<string>;
  "toolStateBindings"?: Array<{
    /** {"minLength":1} */
    "toolId": string;
    /** {"description":"Dot-separated path in the Tool's arguments.","minLength":1} */
    "argumentPath": string;
    /** {"description":"Dot-separated path in the Agent's scoped State.","minLength":1} */
    "statePath": string;
  }>;
  /** {"minimum":1,"maximum":50,"default":8} */
  "maxToolCalls"?: number;
  /** {"minimum":1,"maximum":600,"default":60} */
  "toolTimeoutSeconds"?: number;
}
