export type MatchAlgorithm = 'exact' | 'contains' | 'levenshtein';

export type AssertionSubject = 'final_json' | 'final_text';

export type AssertionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | MatchAlgorithm;

export type VisualAssertion = {
  id: string;
  subject: AssertionSubject;
  path: string;
  operator: AssertionOperator;
  expected: string;
};

export type ImportConflictStrategy = 'create' | 'overwrite' | 'skip';

export type ImportedCase = {
  index: number;
  name: string;
  description: string;
  enabled: boolean;
  input: unknown;
  expectation: unknown;
  fixture: unknown;
  errors: string[];
};

export type TestImportPreview = {
  suiteName: string;
  suiteDescription: string;
  cases: ImportedCase[];
  errors: string[];
};

export type ToolCallDraft = {
  id: string;
  name: string;
  args: string;
  count: number;
  assertResult: boolean;
  expectedResult: string;
};

export type ToolTrajectoryDraft = {
  id?: string;
  strictOrder: boolean;
  strictArgs: boolean;
  calls: ToolCallDraft[];
};

export type NodeTrajectoryDraft = {
  id?: string;
  mustExecute: string[];
  mustNotExecute: string[];
  orderedNodes: string[];
  requireCompleted: boolean;
};

export type RouteAssertionDraft = {
  id: string;
  nodeId: string;
  expectedRoute: string;
};

export type NodeOutputAssertionDraft = {
  id: string;
  nodeId: string;
  path: string;
  operator: Exclude<AssertionOperator, MatchAlgorithm>;
  expected: string;
};

export type NodeTextAssertionDraft = {
  id: string;
  nodeId: string;
  algorithm: MatchAlgorithm;
  expected: string;
};

export type NodeToolAssertionDraft = {
  id: string;
  nodeId: string;
  toolName: string;
  count: number;
};

export type WorkflowRouteOption = {
  nodeId: string;
  nodeLabel: string;
  route: string;
  label: string;
};

export type ToolFixtureDraft = {
  id: string;
  nodeId: string;
  tool: string;
  args: string;
  result: string;
};

export type SafetyTarget = 'final_output' | 'tool_arguments' | 'tool_results';

export type SafetyAssertionDraft = {
  id: string;
  target: SafetyTarget;
  fieldPaths: string;
  forbiddenText: string;
};
