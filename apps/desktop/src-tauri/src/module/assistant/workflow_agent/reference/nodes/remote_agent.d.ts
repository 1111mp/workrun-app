// Generated from JSON Schema. Runtime validation remains authoritative.
export interface RemoteAgentNodeData {
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
  /** {"minLength":1} */
  "url": string;
  /** {"minimum":1,"maximum":600,"default":120} */
  "timeoutSeconds"?: number;
  /** {"uniqueItems":true} */
  "attachmentPaths"?: Array<string>;
  "authentication"?: {
    "type": "none" | "bearer" | "apiKey";
    /** {"minLength":1} */
    "credentialId"?: string;
    /** {"minLength":1} */
    "headerName"?: string;
  };
  /** {"description":"Read get_workflow_reference(topic=compensation) for the declaration: mode unspecified/read_only/irreversible/compensatable/delegated; compiler validates nested action, bindings and idempotency."} */
  "compensation"?: {
    [key: string]: unknown;
  };
}
