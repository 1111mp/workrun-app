import { invoke } from '@tauri-apps/api/core';

export type EvaluationSuite = {
  id: string;
  workflowId: string;
  name: string;
  description: string;
  caseCount: number;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationCase = {
  id: string;
  suiteId: string;
  name: string;
  description: string;
  position: number;
  enabled: boolean;
  targetAgentId?: string | null;
  input: unknown;
  expectation: unknown;
  fixture: unknown;
  createdAt: string;
  updatedAt: string;
};

export type EvaluationRun = {
  id: string;
  suiteId: string;
  workflowId: string;
  status: string;
  totalCases: number;
  startedAt: string;
};

export type EvaluationRunDetail = EvaluationRun & {
  endedAt?: string | null;
  durationMs?: number | null;
  passedCases: number;
  failedCases: number;
  totalTokens?: number | null;
  estimatedCostMicrousd?: number | null;
  error?: string | null;
};

export type EvaluationCaseResult = {
  id: string;
  evaluationCaseId: string;
  workflowRunId?: string | null;
  executionStatus: 'queued' | 'running' | 'completed' | 'failed';
  verdict: 'pending' | 'passed' | 'failed' | 'error';
  score?: number | null;
  actualOutput: unknown;
  criteriaResults: unknown;
  normalizedTrace: unknown;
  failureReason?: string | null;
  durationMs?: number | null;
  totalTokens?: number | null;
  estimatedCostMicrousd?: number | null;
};

export type EvaluationWorkflowSnapshot = {
  targetName: string;
  targetSnapshot: unknown;
  dsl: unknown;
  releaseId?: string;
  releaseVersion?: string;
};

export function listEvaluationSuites(workflowId: string) {
  return invoke<EvaluationSuite[]>('evaluation_suite_list', { workflowId });
}

export function createEvaluationSuite(request: {
  id: string;
  workflowId: string;
  name: string;
  description: string;
}) {
  return invoke<EvaluationSuite>('evaluation_suite_create', { request });
}

export function updateEvaluationSuite(request: {
  id: string;
  name: string;
  description: string;
}) {
  return invoke<EvaluationSuite>('evaluation_suite_update', { request });
}

export function deleteEvaluationSuite(id: string) {
  return invoke('evaluation_suite_delete', { id });
}

export function listEvaluationCases(suiteId: string) {
  return invoke<EvaluationCase[]>('evaluation_case_list', { suiteId });
}

export function createEvaluationCase(request: {
  id: string;
  suiteId: string;
  name: string;
  description: string;
  position: number;
  enabled: boolean;
  targetAgentId?: string;
  input: unknown;
  expectation: unknown;
  fixture: unknown;
}) {
  return invoke<EvaluationCase>('evaluation_case_create', { request });
}

export function updateEvaluationCase(request: {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  targetAgentId?: string;
  input: unknown;
  expectation: unknown;
  fixture: unknown;
}) {
  return invoke<EvaluationCase>('evaluation_case_update', { request });
}

export function deleteEvaluationCase(id: string) {
  return invoke('evaluation_case_delete', { id });
}

export function reorderEvaluationCases(suiteId: string, ids: string[]) {
  return invoke('evaluation_case_reorder', { suiteId, ids });
}

export function createEvaluationRun(request: {
  id: string;
  suiteId: string;
  workflowId: string;
  workflowSnapshot: EvaluationWorkflowSnapshot;
}) {
  return invoke<EvaluationRun>('evaluation_run_create', { request });
}

export function startNextEvaluationCase(evaluationRunId: string) {
  return invoke('evaluation_run_start_next_case', { evaluationRunId });
}

export function listEvaluationCaseResults(evaluationRunId: string) {
  return invoke<EvaluationCaseResult[]>('evaluation_run_case_results', {
    evaluationRunId,
  });
}

export function inspectEvaluationRun(evaluationRunId: string) {
  return invoke<EvaluationRunDetail>('evaluation_run_inspect', {
    evaluationRunId,
  });
}

export function listEvaluationRuns(suiteId: string) {
  return invoke<EvaluationRunDetail[]>('evaluation_run_list', { suiteId });
}
