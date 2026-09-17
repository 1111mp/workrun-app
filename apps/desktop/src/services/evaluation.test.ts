import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  compareEvaluationVersions,
  listEvaluationCases,
  latestEvaluationRunsForWorkflowSnapshot,
  recordEvaluationQualityGateOverride,
  restoreEvaluationCase,
  updateEvaluationQualityGate,
} from './evaluation';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('evaluation service contracts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps archived cases opt-in and restores by id', async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    await listEvaluationCases('suite-1');
    await listEvaluationCases('suite-1', true);
    await restoreEvaluationCase('case-1');

    expect(invoke).toHaveBeenNthCalledWith(1, 'evaluation_case_list', {
      suiteId: 'suite-1',
      includeArchived: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'evaluation_case_list', {
      suiteId: 'suite-1',
      includeArchived: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'evaluation_case_restore', {
      id: 'case-1',
    });
  });

  it('sends both selected versions when comparing case verdicts', async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    await compareEvaluationVersions('suite-1', '1.0.0', '2.0.0');

    expect(invoke).toHaveBeenCalledWith('evaluation_version_compare', {
      suiteId: 'suite-1',
      baseline: '1.0.0',
      candidate: '2.0.0',
    });
  });

  it('queries only runs that match the current workflow snapshot', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const workflowSnapshot = {
      targetName: 'Checkout',
      targetSnapshot: { nodes: [{ id: 'agent-1' }] },
      dsl: { nodes: [{ id: 'agent-1' }] },
    };

    await latestEvaluationRunsForWorkflowSnapshot(
      'workflow-1',
      workflowSnapshot,
    );

    expect(invoke).toHaveBeenCalledWith('evaluation_workflow_snapshot_runs', {
      workflowId: 'workflow-1',
      workflowSnapshot,
    });
  });

  it('preserves all quality thresholds when saving a release gate', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const policy = {
      requireEvaluation: true,
      minPassRate: 0.95,
      maxCostMicrousd: 1_500_000,
      maxDurationMs: 60_000,
      requiredSuiteIds: ['suite-1'],
    };

    await updateEvaluationQualityGate('workflow-1', policy);

    expect(invoke).toHaveBeenCalledWith('evaluation_quality_gate_update', {
      workflowId: 'workflow-1',
      policy,
    });
  });

  it('records the gate and evaluation snapshots for a publish override', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const request = {
      workflowId: 'workflow-1',
      releaseVersion: '2.0.0',
      reason: 'Emergency customer fix',
      gateSnapshot: { minPassRate: 1 },
      evaluationSnapshot: { passedCases: 9, totalCases: 10 },
    };

    await recordEvaluationQualityGateOverride(request);

    expect(invoke).toHaveBeenCalledWith(
      'evaluation_quality_gate_record_override',
      { request },
    );
  });
});
