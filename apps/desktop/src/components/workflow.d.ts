type WorkflowBaseNode = {
  id: string;
};

type WorkflowNodeType =
  | 'agent'
  | 'remote_agent'
  | 'codeact_agent'
  | 'process'
  | 'start'
  | 'end'
  | 'if_else'
  | 'switch'
  | 'human_review'
  | 'ask_user_question'
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

type WorkflowSkillRef = {
  source: 'personal';
  name: string;
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
  /** Optional state key that receives the agent's complete final text. */
  outputKey?: string;
  temperature?: number;
  topP?: number;
  skillRefs?: WorkflowSkillRef[];
  toolIds?: string[];
  maxToolCalls?: number;
  toolTimeoutSeconds?: number;
};
type WorkflowAgentNode = WorkflowBaseNode & {
  type: 'agent';
  data: WorkflowAgentNodeData;
};

// ---------- CodeAct Agent Node ----------
type WorkflowCodeActMount = {
  virtualPath: string;
  hostPath: string;
  access: 'read_only' | 'read_write';
};
type WorkflowCodeActEnvironmentBinding = {
  name: string;
  value: string;
};
type WorkflowCodeActAgentNodeData = {
  name: string;
  modelProfileId: string;
  description: string;
  instruction: string;
  toolIds?: string[];
  maxIterations?: number;
  maxToolCalls?: number;
  toolTimeoutSeconds?: number;
  maxScriptDurationSeconds?: number;
  maxScriptMemoryMiB?: number;
  systemClock?: boolean;
  mounts?: WorkflowCodeActMount[];
  environment?: WorkflowCodeActEnvironmentBinding[];
};
type WorkflowCodeActAgentNode = WorkflowBaseNode & {
  type: 'codeact_agent';
  data: WorkflowCodeActAgentNodeData;
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

// ---------- Process Node ----------
type WorkflowProcessNodeData = {
  name: string;
  processNodeId: string;
  description: string;
};
type WorkflowProcessNode = WorkflowBaseNode & {
  type: 'process';
  data: WorkflowProcessNodeData;
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

// ---------- If/Else Node ----------
type WorkflowIfElseBranch = {
  label: string;
  condition: string;
};

type WorkflowIfElseNodeData = {
  label?: string;
  /** Conditions evaluated independently for the two outgoing branches. */
  conditions: {
    true: WorkflowIfElseBranch;
    false: WorkflowIfElseBranch;
  };
};
type WorkflowIfElseNode = WorkflowBaseNode & {
  type: 'if_else';
  data: WorkflowIfElseNodeData;
};

// ---------- Switch Node ----------
type WorkflowSwitchCase = {
  /** Stable identifier used as the React Flow source handle ID. */
  id: string;
  /** Human-readable branch name shown on the canvas. */
  label: string;
  /** Expression evaluated against workflow state for this branch. */
  condition: string;
};
type WorkflowSwitchDefault = {
  /** Human-readable fallback branch name shown on the canvas. */
  label: string;
  /** Description of the unmatched cases; this is not evaluated. */
  condition: string;
};
type WorkflowSwitchNodeData = {
  label?: string;
  cases: WorkflowSwitchCase[];
  /** Fallback branch used when no case condition matches. */
  defaultCase: WorkflowSwitchDefault;
};
type WorkflowSwitchNode = WorkflowBaseNode & {
  type: 'switch';
  data: WorkflowSwitchNodeData;
};

// ---------- Human Review Node ----------
type WorkflowHumanReviewNodeData = {
  title: string;
  description: string;
  /** State key whose value is presented to the reviewer. */
  contentKey?: string;
  /** Whether the reviewer may edit the string value before approval. */
  editable?: boolean;
  /** Additional read-only state values shown with the review content. */
  contextKeys?: string[];
};
type WorkflowHumanReviewNode = WorkflowBaseNode & {
  type: 'human_review';
  data: WorkflowHumanReviewNodeData;
};

// ---------- Ask User Question Node ----------
type WorkflowAskUserQuestionOption = {
  /** Stable identifier used as the React Flow source handle ID. */
  id: string;
  /** Text presented to the person answering the question. */
  label: string;
  description?: string;
};
type WorkflowAskUserQuestionNodeData = {
  title: string;
  description: string;
  options: WorkflowAskUserQuestionOption[];
};
type WorkflowAskUserQuestionNode = WorkflowBaseNode & {
  type: 'ask_user_question';
  data: WorkflowAskUserQuestionNodeData;
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
  | WorkflowCodeActAgentNode
  | WorkflowRemoteAgentNode
  | WorkflowProcessNode
  | WorkflowHumanReviewNode
  | WorkflowAskUserQuestionNode
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
