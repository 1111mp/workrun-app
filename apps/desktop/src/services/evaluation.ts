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
  archived: boolean;
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
  retryOfRunId?: string | null;
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
export type EvaluationVersionSummary = {
  releaseId?: string | null;
  releaseVersion: string;
  comparisonKey: string;
  runCount: number;
  totalCases: number;
  passedCases: number;
  totalDurationMs: number;
  estimatedCostMicrousd: number;
};
export type EvaluationVersionCaseDiff = { caseId: string; name: string; baselineVerdict?: string | null; candidateVerdict?: string | null; kind: 'added' | 'removed' | 'regressed' | 'fixed' | 'persistent_failure' };
export type EvaluationCriterionOutcome = { criterion: string; passed: boolean; score: number; threshold: number; expected: unknown; actual: unknown };
export type EvaluationVersionCriterionDiff = { key: string; baseline?: EvaluationCriterionOutcome | null; candidate?: EvaluationCriterionOutcome | null; kind: 'added' | 'removed' | 'regressed' | 'fixed' | 'persistent_failure' | 'persistent_pass' };
export type EvaluationVersionCaseCriterionComparison = { caseId: string; name: string; baselineVerdict?: string | null; candidateVerdict?: string | null; criteria: EvaluationVersionCriterionDiff[] };
export type EvaluationQualityGate = {
  requireEvaluation: boolean;
  minPassRate?: number | null;
  maxCostMicrousd?: number | null;
  maxDurationMs?: number | null;
  requiredSuiteIds: string[];
};

export type EvaluationCaseResult = {
  id: string;
  evaluationCaseId: string;
  workflowRunId?: string | null;
  executionStatus: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  verdict: 'pending' | 'passed' | 'failed' | 'error' | 'skipped';
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

export function listEvaluationCases(suiteId: string, includeArchived = false) {
  return invoke<EvaluationCase[]>('evaluation_case_list', { suiteId, includeArchived });
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
export function restoreEvaluationCase(id: string) { return invoke('evaluation_case_restore', { id }); }

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

export function retryFailedEvaluationCases(sourceRunId: string, id: string) {
  return invoke<EvaluationRun>('evaluation_run_retry_failed', { sourceRunId, id });
}

export function cancelEvaluationRun(evaluationRunId: string) {
  return invoke('evaluation_run_cancel', { evaluationRunId });
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

export function summarizeEvaluationVersions(suiteId: string) {
  return invoke<EvaluationVersionSummary[]>('evaluation_version_summary', { suiteId });
}
export function compareEvaluationVersions(suiteId: string, baseline: string, candidate: string) { return invoke<EvaluationVersionCaseDiff[]>('evaluation_version_compare', { suiteId, baseline, candidate }); }
export function compareEvaluationVersionCaseCriteria(suiteId: string, baseline: string, candidate: string, caseId: string) {
  return invoke<EvaluationVersionCaseCriterionComparison>('evaluation_version_case_criteria_compare', { suiteId, baseline, candidate, caseId });
}

export function latestEvaluationRunForWorkflow(workflowId: string) {
  return invoke<EvaluationRunDetail | null>('evaluation_workflow_latest_run', { workflowId });
}

export function latestEvaluationRunsForWorkflowSnapshot(
  workflowId: string,
  workflowSnapshot: EvaluationWorkflowSnapshot,
) {
  return invoke<EvaluationRunDetail[]>('evaluation_workflow_snapshot_runs', {
    workflowId,
    workflowSnapshot,
  });
}

export function getEvaluationQualityGate(workflowId: string) {
  return invoke<EvaluationQualityGate>('evaluation_quality_gate_get', { workflowId });
}

export function updateEvaluationQualityGate(workflowId: string, policy: EvaluationQualityGate) {
  return invoke('evaluation_quality_gate_update', { workflowId, policy });
}

export function recordEvaluationQualityGateOverride(request: {
  workflowId: string;
  releaseVersion: string;
  reason: string;
  gateSnapshot: unknown;
  evaluationSnapshot: unknown;
}) {
  return invoke('evaluation_quality_gate_record_override', { request });
}
export type QualityGateAudit = { id: string; releaseVersion: string; actor: string; reason: string; gateSnapshot: unknown; evaluationSnapshot: unknown; createdAt: string };
export function listEvaluationQualityGateAudits(workflowId: string) { return invoke<QualityGateAudit[]>('evaluation_quality_gate_audit_list', { workflowId }); }
