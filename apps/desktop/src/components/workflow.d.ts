type WorkflowBaseNode = {
  id: string;
};

type WorkflowNodeType =
  | 'agent'
  | 'remote_agent'
  | 'start'
  | 'end'
  | 'if_else'
  | 'switch'
  | 'group';

type WorkflowMode = 'task' | 'chat';

type WorkflowInputType = 'string' | 'textarea' | 'number' | 'boolean';

/** A parameter accepted by one workflow run. Values are never stored here. */
type WorkflowInput = {
  id: string;
  key: string;
  label: string;
  type: WorkflowInputType;
  required: boolean;
  description?: string;
};

type WorkflowSettings = {
  name: string;
  description: string;
  mode: WorkflowMode;
  inputSchema: {
    fields: WorkflowInput[];
  };
};

// ---------- Agent Node ----------
type WorkflowAgentNodeData = {
  name: string;
  modelProfileId: string;
  description: string;
  instruction: string;
};
type WorkflowAgentNode = WorkflowBaseNode & {
  type: 'agent';
  data: WorkflowAgentNodeData;
};

// ---------- Remote Agent Node ----------
type WorkflowRemoteAgentNodeData = {
  name: string;
  url: string;
  description: string;
};
type WorkflowRemoteAgentNode = WorkflowBaseNode & {
  type: 'remote_agent';
  data: WorkflowRemoteAgentNodeData;
};

// ---------- Start Node ----------
type WorkflowStartNodeData = {
  label?: string;
};
type WorkflowStartNode = WorkflowBaseNode & {
  type: 'start';
  data: WorkflowStartNodeData;
};

// ---------- End Node ----------
type WorkflowEndNodeData = {
  label?: string;
};
type WorkflowEndNode = WorkflowBaseNode & {
  type: 'end';
  data: WorkflowEndNodeData;
};

/**
 * A state field consumed by an adk-graph router. The compiler turns this into
 * `Router::by_bool(field)` or `Router::by_field(field)` where possible.
 */
type WorkflowRouteSelector = {
  field: string;
};

// ---------- If/Else Node ----------
type WorkflowIfElseNodeData = {
  label?: string;
  /** State field that contains the boolean used by `Router::by_bool`. */
  selector: WorkflowRouteSelector;
};
type WorkflowIfElseNode = WorkflowBaseNode & {
  type: 'if_else';
  data: WorkflowIfElseNodeData;
};

// ---------- Switch Node ----------
type WorkflowSwitchCase = {
  /** Stable identifier used as the React Flow source handle ID. */
  id: string;
  /** Value returned by the router; this is the key used by adk-graph. */
  value: string;
  /** Human-readable branch name. Changing it must not change routing. */
  label: string;
};
type WorkflowSwitchNodeData = {
  label?: string;
  /** State field that contains the routing value. */
  selector: WorkflowRouteSelector;
  cases: WorkflowSwitchCase[];
  /** Display name for the fallback branch, routed with the `default` key. */
  defaultLabel?: string;
};
type WorkflowSwitchNode = WorkflowBaseNode & {
  type: 'switch';
  data: WorkflowSwitchNodeData;
};

// ---------- Group Layout Node ----------
type WorkflowGroupNodeData = {
  /** Human-readable title shown in the group header. */
  label?: string;
};
type WorkflowGroupNode = WorkflowBaseNode & {
  type: 'group';
  data: WorkflowGroupNodeData;
};

type WorkflowNode =
  // basic nodes
  | WorkflowAgentNode
  | WorkflowRemoteAgentNode
  // control nodes
  | WorkflowStartNode
  | WorkflowEndNode
  | WorkflowIfElseNode
  | WorkflowSwitchNode
  | WorkflowGroupNode;

/** Execution-relevant subset of a React Flow edge. */
type WorkflowEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

type Workflow = {
  id: string;
  name: string;
  description?: string;
  mode: WorkflowMode;
  inputSchema: WorkflowSettings['inputSchema'];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};
