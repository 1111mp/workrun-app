import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@workspace/ui/components';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BeakerIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  Settings2Icon,
  TestTubeDiagonalIcon,
  Trash2Icon,
  UploadIcon,
  XCircleIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  compareEvaluationVersionCaseCriteria,
  compareEvaluationVersions,
  createEvaluationCase,
  createEvaluationRun,
  createEvaluationSuite,
  deleteEvaluationCase,
  deleteEvaluationSuite,
  getEvaluationQualityGate,
  inspectEvaluationRun,
  listEvaluationCaseResults,
  listEvaluationCases,
  listEvaluationRuns,
  listEvaluationSuites,
  reorderEvaluationCases,
  restoreEvaluationCase,
  startNextEvaluationCase,
  summarizeEvaluationVersions,
  updateEvaluationCase,
  updateEvaluationQualityGate,
  updateEvaluationSuite,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationQualityGate,
  type EvaluationSuite,
  type EvaluationVersionCaseDiff,
  type EvaluationWorkflowSnapshot,
} from '@/services/evaluation';
import { listTools } from '@/services/tool';

import {
  expectationFromVisualAssertions,
  fixturesFromDrafts,
  jsonObject,
  nodeOutputAssertionDrafts,
  nodeTextAssertionDrafts,
  nodeToolAssertionDrafts,
  nodeTrajectoryDraft,
  routeAssertionDrafts,
  safetyAssertionDrafts,
  serializeVisualAssertions,
  testImportPreview,
  toolFixtureDrafts,
  toolTrajectoryDraft,
  visualAssertions,
} from './assertion-utils';
import { CaseEditorDialog } from './case-editor-dialog';
import { DeleteCaseDialog, DeleteSuiteDialog } from './delete-dialogs';
import { EvaluationImportDialog } from './import-dialog';
import { QualityGateDialog } from './quality-gate-dialog';
import { EvaluationResultDialog } from './result-dialog';
import {
  EvaluationTrends,
  formatCost,
  formatDuration,
  formatNumber,
  versionDiffLabel,
  versionKey,
  versionPassRate,
} from './run-panel';
import { SuiteDialog } from './suite-dialog';
import { adkTestFile } from './test-file-utils';
import type {
  ImportConflictStrategy,
  NodeOutputAssertionDraft,
  NodeTextAssertionDraft,
  NodeToolAssertionDraft,
  NodeTrajectoryDraft,
  RouteAssertionDraft,
  SafetyAssertionDraft,
  TestImportPreview,
  ToolFixtureDraft,
  ToolTrajectoryDraft,
  VisualAssertion,
} from './types';
import { VersionDiffDialog } from './version-diff-dialog';
import {
  evaluationCoverage,
  workflowAgentNodes,
  workflowEvaluationNodes,
  workflowRoutes,
  workflowToolIds,
} from './workflow-utils';
const RESULT_STYLE: Record<EvaluationCaseResult['verdict'], string> = {
  pending: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  passed:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  error:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

type RunOutcome = 'passed' | 'failed' | 'running' | 'queued';

const RUN_OUTCOME_STYLE: Record<
  RunOutcome,
  { badge: string; rail: string; meter: string }
> = {
  passed: {
    badge:
      'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    rail: 'border-l-emerald-500',
    meter: 'bg-emerald-500',
  },
  failed: {
    badge: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
    rail: 'border-l-rose-500',
    meter: 'bg-rose-500',
  },
  running: {
    badge: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    rail: 'border-l-sky-500',
    meter: 'bg-sky-500',
  },
  queued: {
    badge:
      'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    rail: 'border-l-amber-500',
    meter: 'bg-amber-500',
  },
};

function runOutcome(run: {
  status: string;
  passedCases: number;
  totalCases: number;
  failedCases: number;
}): RunOutcome {
  if (run.status === 'queued') return 'queued';
  if (run.status === 'running') return 'running';
  if (run.failedCases > 0 || run.passedCases < run.totalCases) return 'failed';
  return 'passed';
}

function ResultIcon({ verdict }: { verdict: EvaluationCaseResult['verdict'] }) {
  if (verdict === 'passed')
    return <CheckCircle2Icon className='size-4 text-emerald-500' />;
  if (verdict === 'failed')
    return <XCircleIcon className='text-destructive size-4' />;
  if (verdict === 'error')
    return <CircleAlertIcon className='size-4 text-amber-500' />;
  return <TestTubeDiagonalIcon className='text-muted-foreground size-4' />;
}

export function WorkflowEvaluations({
  workflowId,
  workflowSnapshot,
  onViewWorkflowRun,
}: {
  workflowId: string;
  workflowSnapshot: EvaluationWorkflowSnapshot;
  onViewWorkflowRun: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [baselineVersion, setBaselineVersion] = useState<string>();
  const [candidateVersion, setCandidateVersion] = useState<string>();
  const [selectedVersionDiff, setSelectedVersionDiff] =
    useState<EvaluationVersionCaseDiff>();
  const [showArchivedCases, setShowArchivedCases] = useState(false);
  const [selectedResult, setSelectedResult] = useState<EvaluationCaseResult>();
  const [suiteDialogOpen, setSuiteDialogOpen] = useState(false);
  const [qualityGateOpen, setQualityGateOpen] = useState(false);
  const [testImport, setTestImport] = useState<TestImportPreview>();
  const [suiteImportStrategy, setSuiteImportStrategy] =
    useState<ImportConflictStrategy>('create');
  const [caseImportStrategy, setCaseImportStrategy] =
    useState<ImportConflictStrategy>('create');
  const [importing, setImporting] = useState(false);
  const [qualityGate, setQualityGate] = useState<EvaluationQualityGate>({
    requireEvaluation: false,
    requiredSuiteIds: [],
  });
  const [caseDialogOpen, setCaseDialogOpen] = useState(false);
  const [editingSuite, setEditingSuite] = useState<EvaluationSuite>();
  const [editingCase, setEditingCase] = useState<EvaluationCase>();
  const [deleteSuite, setDeleteSuite] = useState<EvaluationSuite>();
  const [deleteCase, setDeleteCase] = useState<EvaluationCase>();
  const [suiteName, setSuiteName] = useState('');
  const [suiteDescription, setSuiteDescription] = useState('');
  const [caseName, setCaseName] = useState('');
  const [caseDescription, setCaseDescription] = useState('');
  const [caseInput, setCaseInput] = useState('{}');
  const [caseExpectation, setCaseExpectation] = useState<unknown>();
  const [assertionDrafts, setAssertionDrafts] = useState<VisualAssertion[]>([]);
  const [toolTrajectory, setToolTrajectory] = useState<ToolTrajectoryDraft>({
    strictOrder: true,
    strictArgs: false,
    calls: [],
  });
  const [nodeTrajectory, setNodeTrajectory] = useState<NodeTrajectoryDraft>({
    mustExecute: [],
    mustNotExecute: [],
    orderedNodes: [],
    requireCompleted: true,
  });
  const [routeDrafts, setRouteDrafts] = useState<RouteAssertionDraft[]>([]);
  const [nodeOutputDrafts, setNodeOutputDrafts] = useState<
    NodeOutputAssertionDraft[]
  >([]);
  const [nodeTextDrafts, setNodeTextDrafts] = useState<
    NodeTextAssertionDraft[]
  >([]);
  const [nodeToolDrafts, setNodeToolDrafts] = useState<
    NodeToolAssertionDraft[]
  >([]);
  const [fixtureDrafts, setFixtureDrafts] = useState<ToolFixtureDraft[]>([]);
  const [safetyDrafts, setSafetyDrafts] = useState<SafetyAssertionDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const startingNext = useRef(false);
  const assertionsJson = JSON.stringify(
    serializeVisualAssertions(
      assertionDrafts,
      toolTrajectory,
      nodeTrajectory,
      routeDrafts,
      nodeOutputDrafts,
      nodeTextDrafts,
      nodeToolDrafts,
      safetyDrafts,
      t,
    ),
    null,
    2,
  );

  const suites = useQuery({
    queryKey: ['evaluation-suites', workflowId],
    queryFn: () => listEvaluationSuites(workflowId),
  });
  const savedQualityGate = useQuery({
    queryKey: ['evaluation-quality-gate', workflowId],
    queryFn: () => getEvaluationQualityGate(workflowId),
  });
  // Keep the first Suite as a render-time default. It avoids an extra render
  // after query completion while preserving an explicit user selection.
  const effectiveSuiteId = selectedSuiteId ?? suites.data?.[0]?.id;
  const selectedSuite = suites.data?.find(
    (suite) => suite.id === effectiveSuiteId,
  );
  const selectSuite = (suiteId?: string) => {
    // A Run belongs to exactly one Suite. Keeping it selected across a Suite
    // change mixes immutable historical evidence with unrelated Case rows.
    setActiveRunId(undefined);
    setSelectedResult(undefined);
    setSelectedSuiteId(suiteId);
  };
  const openQualityGate = () => {
    setQualityGate(
      savedQualityGate.data ?? {
        requireEvaluation: false,
        requiredSuiteIds: [],
      },
    );
    setQualityGateOpen(true);
  };
  const saveQualityGate = async () => {
    try {
      await updateEvaluationQualityGate(workflowId, qualityGate);
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-quality-gate', workflowId],
      });
      setQualityGateOpen(false);
      toast.success(t('evaluations.feedback.qualityGateSaved'), {
        toasterId: 'global',
      });
    } catch (error) {
      toast.error(t('evaluations.feedback.qualityGateSaveFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    }
  };
  const cases = useQuery({
    queryKey: ['evaluation-cases', effectiveSuiteId, showArchivedCases],
    queryFn: () => listEvaluationCases(effectiveSuiteId!, showArchivedCases),
    enabled: Boolean(effectiveSuiteId),
  });
  const results = useQuery({
    queryKey: ['evaluation-case-results', activeRunId],
    queryFn: () => listEvaluationCaseResults(activeRunId!),
    enabled: Boolean(activeRunId),
    // Preserve the detail panel while switching between entries in Run history.
    placeholderData: keepPreviousData,
  });
  const runDetail = useQuery({
    queryKey: ['evaluation-run', activeRunId],
    queryFn: () => inspectEvaluationRun(activeRunId!),
    enabled: Boolean(activeRunId),
    placeholderData: keepPreviousData,
  });
  const runHistory = useQuery({
    queryKey: ['evaluation-run-history', effectiveSuiteId],
    queryFn: () => listEvaluationRuns(effectiveSuiteId!),
    enabled: Boolean(effectiveSuiteId),
  });
  const versionSummary = useQuery({
    queryKey: ['evaluation-version-summary', effectiveSuiteId],
    queryFn: () => summarizeEvaluationVersions(effectiveSuiteId!),
    enabled: Boolean(effectiveSuiteId),
  });
  const baseline = versionSummary.data?.find(
    (item) => versionKey(item) === baselineVersion,
  );
  const candidate = versionSummary.data?.find(
    (item) => versionKey(item) === candidateVersion,
  );
  const versionDiff = useQuery({
    queryKey: [
      'evaluation-version-diff',
      effectiveSuiteId,
      baseline?.releaseVersion,
      candidate?.releaseVersion,
    ],
    queryFn: () =>
      compareEvaluationVersions(
        effectiveSuiteId!,
        baseline!.releaseVersion,
        candidate!.releaseVersion,
      ),
    enabled: Boolean(
      effectiveSuiteId &&
      baseline &&
      candidate &&
      baselineVersion !== candidateVersion,
    ),
  });
  const versionCriteriaDiff = useQuery({
    queryKey: [
      'evaluation-version-criteria-diff',
      effectiveSuiteId,
      baseline?.releaseVersion,
      candidate?.releaseVersion,
      selectedVersionDiff?.caseId,
    ],
    queryFn: () =>
      compareEvaluationVersionCaseCriteria(
        effectiveSuiteId!,
        baseline!.releaseVersion,
        candidate!.releaseVersion,
        selectedVersionDiff!.caseId,
      ),
    enabled: Boolean(
      effectiveSuiteId && baseline && candidate && selectedVersionDiff,
    ),
  });
  const toolCatalog = useQuery({
    queryKey: ['tool-catalog'],
    queryFn: listTools,
  });
  const configuredToolIds = workflowToolIds(workflowSnapshot);
  const configuredTools =
    toolCatalog.data?.filter((tool) => configuredToolIds.has(tool.id)) ?? [];
  const configuredWorkflowNodes = workflowEvaluationNodes(workflowSnapshot, t);
  const configuredRoutes = workflowRoutes(workflowSnapshot);
  const configuredAgentNodes = workflowAgentNodes(workflowSnapshot);
  const configuredRouteNodes = Array.from(
    new Map(configuredRoutes.map((route) => [route.nodeId, route])).values(),
  );
  // Coverage only reflects active cases: archived or disabled cases cannot protect a workflow change.
  const coverage = evaluationCoverage(
    cases.data ?? [],
    configuredWorkflowNodes,
    configuredRoutes,
  );

  useEffect(() => {
    const rows = results.data;
    if (!activeRunId || !rows?.length || startingNext.current) return;
    if (rows.some((row) => row.executionStatus === 'running')) return;
    if (!rows.some((row) => row.executionStatus === 'queued')) return;

    startingNext.current = true;
    void startNextEvaluationCase(activeRunId)
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: ['evaluation-case-results', activeRunId],
        }),
      )
      .catch((error) => {
        toast.error(t('evaluations.feedback.nextCaseStartFailed'), {
          toasterId: 'global',
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        startingNext.current = false;
      });
  }, [activeRunId, queryClient, results.data, t]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ runId: string }>('run-status-changed', ({ payload }) => {
      // Workflow completion is emitted only after EvaluationStore has scored
      // its linked Case, so this event is the durable replacement for polling.
      if (!results.data?.some((row) => row.workflowRunId === payload.runId))
        return;
      void queryClient.invalidateQueries({
        queryKey: ['evaluation-case-results', activeRunId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['evaluation-run', activeRunId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['evaluation-run-history', effectiveSuiteId],
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeRunId, effectiveSuiteId, queryClient, results.data]);

  const openSuiteEditor = (suite?: EvaluationSuite) => {
    setEditingSuite(suite);
    setSuiteName(suite?.name ?? '');
    setSuiteDescription(suite?.description ?? '');
    setSuiteDialogOpen(true);
  };

  const saveSuite = async () => {
    if (!suiteName.trim()) return;
    setSaving(true);
    try {
      const suite = editingSuite
        ? await updateEvaluationSuite({
            id: editingSuite.id,
            name: suiteName.trim(),
            description: suiteDescription.trim(),
          })
        : await createEvaluationSuite({
            id: crypto.randomUUID(),
            workflowId,
            name: suiteName.trim(),
            description: suiteDescription.trim(),
          });
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-suites', workflowId],
      });
      selectSuite(suite.id);
      setSuiteDialogOpen(false);
      setEditingSuite(undefined);
      setSuiteName('');
      setSuiteDescription('');
    } catch (error) {
      toast.error(t('evaluations.feedback.suiteSaveFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const removeSuite = async () => {
    if (!deleteSuite) return;
    setSaving(true);
    try {
      await deleteEvaluationSuite(deleteSuite.id);
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-suites', workflowId],
      });
      if (selectedSuite?.id === deleteSuite.id) selectSuite(undefined);
      setDeleteSuite(undefined);
    } catch (error) {
      toast.error(t('evaluations.feedback.suiteDeleteFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const openCaseEditor = (item?: EvaluationCase) => {
    setEditingCase(item);
    setCaseName(item?.name ?? '');
    setCaseDescription(item?.description ?? '');
    setCaseInput(JSON.stringify(item?.input ?? {}, null, 2));
    setCaseExpectation(item?.expectation);
    setAssertionDrafts(visualAssertions(item?.expectation));
    setToolTrajectory(toolTrajectoryDraft(item?.expectation));
    setNodeTrajectory(nodeTrajectoryDraft(item?.expectation));
    setRouteDrafts(routeAssertionDrafts(item?.expectation));
    setNodeOutputDrafts(nodeOutputAssertionDrafts(item?.expectation));
    setNodeTextDrafts(nodeTextAssertionDrafts(item?.expectation));
    setNodeToolDrafts(nodeToolAssertionDrafts(item?.expectation));
    setFixtureDrafts(toolFixtureDrafts(item?.fixture));
    setSafetyDrafts(safetyAssertionDrafts(item?.expectation));
    setCaseDialogOpen(true);
  };

  const saveCase = async () => {
    if (
      !selectedSuite ||
      !caseName.trim() ||
      (!assertionDrafts.length &&
        !toolTrajectory.calls.length &&
        !nodeTrajectory.mustExecute.length &&
        !nodeTrajectory.mustNotExecute.length &&
        !nodeTrajectory.orderedNodes.length &&
        !routeDrafts.length &&
        !nodeOutputDrafts.length &&
        !nodeTextDrafts.length &&
        !nodeToolDrafts.length)
    )
      return;
    setSaving(true);
    try {
      const expectation = expectationFromVisualAssertions(
        caseExpectation,
        assertionDrafts,
        toolTrajectory,
        nodeTrajectory,
        routeDrafts,
        nodeOutputDrafts,
        nodeTextDrafts,
        nodeToolDrafts,
        safetyDrafts,
        t,
      );
      if (editingCase) {
        await updateEvaluationCase({
          id: editingCase.id,
          name: caseName.trim(),
          description: caseDescription.trim(),
          enabled: editingCase.enabled,
          targetAgentId: editingCase.targetAgentId ?? undefined,
          input: jsonObject(caseInput, t('evaluations.workflowInput'), t),
          expectation,
          fixture: fixturesFromDrafts(fixtureDrafts, t),
        });
      } else {
        await createEvaluationCase({
          id: crypto.randomUUID(),
          suiteId: selectedSuite.id,
          name: caseName.trim(),
          description: caseDescription.trim(),
          position: cases.data?.length ?? 0,
          enabled: true,
          input: jsonObject(caseInput, t('evaluations.workflowInput'), t),
          expectation,
          fixture: fixturesFromDrafts(fixtureDrafts, t),
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['evaluation-cases', selectedSuite.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ['evaluation-suites', workflowId],
        }),
      ]);
      setCaseDialogOpen(false);
      setEditingCase(undefined);
      setCaseName('');
      setCaseDescription('');
      setCaseInput('{}');
      setAssertionDrafts([]);
      setToolTrajectory({ strictOrder: true, strictArgs: false, calls: [] });
      setNodeTrajectory({
        mustExecute: [],
        mustNotExecute: [],
        orderedNodes: [],
        requireCompleted: true,
      });
      setRouteDrafts([]);
      setNodeOutputDrafts([]);
      setNodeTextDrafts([]);
      setNodeToolDrafts([]);
      setFixtureDrafts([]);
      setSafetyDrafts([]);
    } catch (error) {
      toast.error(t('evaluations.feedback.caseSaveFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const runSuite = async () => {
    if (!selectedSuite) return;
    setStartingRun(true);
    try {
      const run = await createEvaluationRun({
        id: crypto.randomUUID(),
        suiteId: selectedSuite.id,
        workflowId,
        workflowSnapshot,
      });
      setActiveRunId(run.id);
      await startNextEvaluationCase(run.id);
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-case-results', run.id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-run-history', selectedSuite.id],
      });
    } catch (error) {
      toast.error(t('evaluations.feedback.runStartFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStartingRun(false);
    }
  };

  const refreshCases = async () => {
    if (!selectedSuite) return;
    await queryClient.invalidateQueries({
      queryKey: ['evaluation-cases', selectedSuite.id],
    });
    await queryClient.invalidateQueries({
      queryKey: ['evaluation-suites', workflowId],
    });
  };

  const updateCaseEnabled = async (item: EvaluationCase) => {
    try {
      await updateEvaluationCase({
        ...item,
        enabled: !item.enabled,
        targetAgentId: item.targetAgentId ?? undefined,
      });
      await refreshCases();
    } catch (error) {
      toast.error(t('evaluations.feedback.caseStatusFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    }
  };

  const moveCase = async (item: EvaluationCase, direction: -1 | 1) => {
    if (!selectedSuite || !cases.data) return;
    const index = cases.data.findIndex((candidate) => candidate.id === item.id);
    const target = index + direction;
    if (target < 0 || target >= cases.data.length) return;
    const reordered = [...cases.data];
    [reordered[index], reordered[target]] = [
      reordered[target],
      reordered[index],
    ];
    try {
      await reorderEvaluationCases(
        selectedSuite.id,
        reordered.map((candidate) => candidate.id),
      );
      await refreshCases();
    } catch (error) {
      toast.error(t('evaluations.feedback.caseReorderFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    }
  };

  const duplicateCase = async (item: EvaluationCase) => {
    if (!selectedSuite) return;
    try {
      await createEvaluationCase({
        ...item,
        id: crypto.randomUUID(),
        name: t('evaluations.copyName', { name: item.name }),
        position: cases.data?.length ?? 0,
        targetAgentId: item.targetAgentId ?? undefined,
      });
      await refreshCases();
    } catch (error) {
      toast.error(t('evaluations.feedback.caseCopyFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    }
  };

  const confirmDeleteCase = async () => {
    if (!deleteCase) return;
    try {
      await deleteEvaluationCase(deleteCase.id);
      setDeleteCase(undefined);
      await refreshCases();
    } catch (error) {
      toast.error(t('evaluations.feedback.caseDeleteFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    }
  };
  const restoreCase = async (item: EvaluationCase) => {
    try {
      await restoreEvaluationCase(item.id);
      await refreshCases();
    } catch (error) {
      toast.error(t('evaluations.feedback.caseRestoreFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    }
  };

  const completed =
    results.data?.filter((row) => row.verdict !== 'pending').length ?? 0;
  const passed =
    results.data?.filter((row) => row.verdict === 'passed').length ?? 0;

  const exportCases = async () => {
    if (!selectedSuite || !cases.data) return;
    const path = await save({
      defaultPath: `${selectedSuite.name || 'evaluation'}.test.json`,
      filters: [{ name: 'ADK test file', extensions: ['test.json', 'json'] }],
    });
    if (path)
      await writeTextFile(
        path,
        JSON.stringify(adkTestFile(selectedSuite, cases.data), null, 2),
      );
  };

  const importCases = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: 'ADK test file', extensions: ['test.json', 'json'] }],
      });
      if (!path) return;
      const preview = testImportPreview(
        JSON.parse(await readTextFile(path)),
        t,
      );
      setSuiteImportStrategy('create');
      setCaseImportStrategy('create');
      setTestImport(preview);
    } catch (error) {
      toast.error(t('evaluations.feedback.importFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    }
  };

  const confirmTestImport = async () => {
    if (
      !testImport ||
      testImport.errors.length ||
      testImport.cases.some((item) => item.errors.length)
    )
      return;
    setImporting(true);
    try {
      const matchingSuite = suites.data?.find(
        (item) => item.name === testImport.suiteName,
      );
      if (matchingSuite && suiteImportStrategy === 'skip') {
        toast.message(t('evaluations.feedback.importSkipped'), {
          toasterId: 'global',
        });
        setTestImport(undefined);
        return;
      }
      const targetSuite =
        matchingSuite && suiteImportStrategy === 'overwrite'
          ? await updateEvaluationSuite({
              id: matchingSuite.id,
              name: testImport.suiteName,
              description: testImport.suiteDescription,
            })
          : await createEvaluationSuite({
              id: crypto.randomUUID(),
              workflowId,
              name: testImport.suiteName,
              description: testImport.suiteDescription,
            });
      const targetCases = await listEvaluationCases(targetSuite.id);
      let position = targetCases.length;
      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const item of testImport.cases) {
        const matchingCase = targetCases.find(
          (caseItem) => caseItem.name === item.name,
        );
        if (matchingCase && caseImportStrategy === 'skip') {
          skipped += 1;
          continue;
        }
        if (matchingCase && caseImportStrategy === 'overwrite') {
          await updateEvaluationCase({
            id: matchingCase.id,
            name: item.name,
            description: item.description,
            enabled: item.enabled,
            targetAgentId: matchingCase.targetAgentId ?? undefined,
            input: item.input,
            expectation: item.expectation,
            fixture: item.fixture,
          });
          updated += 1;
          continue;
        }
        await createEvaluationCase({
          id: crypto.randomUUID(),
          suiteId: targetSuite.id,
          name: item.name,
          description: item.description,
          position: position++,
          enabled: item.enabled,
          input: item.input,
          expectation: item.expectation,
          fixture: item.fixture,
        });
        created += 1;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['evaluation-cases', targetSuite.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ['evaluation-suites', workflowId],
        }),
      ]);
      selectSuite(targetSuite.id);
      setTestImport(undefined);
      toast.success(
        t('evaluations.feedback.imported', { created, updated, skipped }),
        { toasterId: 'global' },
      );
    } catch (error) {
      toast.error(t('evaluations.feedback.importFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className='bg-muted/20 flex min-h-0 flex-1 flex-col overflow-y-auto bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_95%_93%/0.5),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_95%_94%/0.24),transparent)] p-5 sm:p-7 dark:bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_70%_20%/0.32),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_70%_18%/0.18),transparent)]'>
      <div className='mx-auto flex w-full max-w-6xl flex-col gap-5'>
        <div className='flex flex-wrap items-end justify-between gap-4'>
          <div>
            <div className='text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium tracking-[0.16em] uppercase'>
              <BeakerIcon className='size-3.5' /> Evaluation lab
            </div>
            <h2 className='text-xl font-semibold tracking-tight'>
              {t('evaluations.title')}
            </h2>
            <p className='text-muted-foreground mt-1 text-sm'>
              {t('evaluations.description')}
            </p>
          </div>
          <div className='flex gap-2'>
            <Button variant='outline' size='sm' onClick={openQualityGate}>
              <Settings2Icon data-icon='inline-start' />{' '}
              {t('evaluations.qualityGate')}
            </Button>
            <Button size='sm' onClick={() => openSuiteEditor()}>
              <PlusIcon data-icon='inline-start' /> {t('evaluations.newSuite')}
            </Button>
          </div>
        </div>

        <div className='grid min-h-108 min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]'>
          <aside className='bg-card rounded-xl border p-2'>
            {suites.isLoading ? (
              <div className='text-muted-foreground flex items-center gap-2 p-3 text-sm'>
                <Spinner /> {t('evaluations.loadingSuites')}
              </div>
            ) : null}
            <div className='flex flex-col gap-1'>
              {suites.data?.map((suite) => (
                <button
                  key={suite.id}
                  type='button'
                  onClick={() => selectSuite(suite.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left transition-colors ${suite.id === effectiveSuiteId ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                >
                  <TestTubeDiagonalIcon className='size-4 shrink-0' />
                  <span className='min-w-0 flex-1 truncate text-sm font-medium'>
                    {suite.name}
                  </span>
                  <span className='text-xs opacity-70'>{suite.caseCount}</span>
                  <ChevronRightIcon className='size-3.5 opacity-60' />
                </button>
              ))}
            </div>
            {!suites.isLoading && !suites.data?.length ? (
              <p className='text-muted-foreground px-3 py-5 text-sm'>
                {t('evaluations.createFirstSuite')}
              </p>
            ) : null}
          </aside>

          <section className='bg-card min-w-0 rounded-xl border p-4 sm:p-5'>
            {!selectedSuite ? (
              <Empty className='min-h-72 border-none'>
                <EmptyHeader>
                  <EmptyMedia variant='icon'>
                    <BeakerIcon />
                  </EmptyMedia>
                  <EmptyTitle>{t('evaluations.noSuiteSelected')}</EmptyTitle>
                  <EmptyDescription>
                    {t('evaluations.noSuiteSelectedDescription')}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className='flex flex-col gap-5'>
                <div className='flex flex-wrap items-start justify-between gap-3 border-b pb-4'>
                  <div>
                    <h3 className='font-semibold'>{selectedSuite.name}</h3>
                    <p className='text-muted-foreground mt-1 text-sm'>
                      {selectedSuite.description ||
                        t('evaluations.noDescription')}
                    </p>
                  </div>
                  <div className='flex flex-wrap justify-end gap-2'>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      title={t('evaluations.import')}
                      aria-label={t('evaluations.import')}
                      onClick={() => void importCases()}
                    >
                      <UploadIcon />
                    </Button>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      title={t('evaluations.export')}
                      aria-label={t('evaluations.export')}
                      onClick={() => void exportCases()}
                    >
                      <DownloadIcon />
                    </Button>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label={t('evaluations.editSuite')}
                      onClick={() => openSuiteEditor(selectedSuite)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label={t('evaluations.deleteSuite')}
                      onClick={() => setDeleteSuite(selectedSuite)}
                    >
                      <Trash2Icon />
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => openCaseEditor()}
                    >
                      <PlusIcon data-icon='inline-start' />{' '}
                      {t('evaluations.addCase')}
                    </Button>
                    <Button
                      size='sm'
                      disabled={!cases.data?.length || startingRun}
                      onClick={() => void runSuite()}
                    >
                      {startingRun ? (
                        <Spinner />
                      ) : (
                        <PlayIcon data-icon='inline-start' />
                      )}{' '}
                      {t('evaluations.runSuite')}
                    </Button>
                  </div>
                </div>
                <div className='grid gap-3 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 sm:grid-cols-3'>
                  <div>
                    <p className='text-muted-foreground text-xs'>
                      {t('evaluations.nodeCoverage')}
                    </p>
                    <p className='mt-1 text-lg font-semibold'>
                      {coverage.coveredNodes.size}/
                      {configuredWorkflowNodes.length}
                    </p>
                  </div>
                  <div>
                    <p className='text-muted-foreground text-xs'>
                      {t('evaluations.routeCoverage')}
                    </p>
                    <p className='mt-1 text-lg font-semibold'>
                      {coverage.coveredRoutes.size}/{configuredRoutes.length}
                    </p>
                  </div>
                  <div>
                    <p className='text-muted-foreground text-xs'>
                      {t('evaluations.staleAssertions')}
                    </p>
                    <p className='mt-1 text-lg font-semibold'>
                      {coverage.stale.length}
                    </p>
                  </div>
                  {coverage.missingNodes.length ||
                  coverage.missingRoutes.length ||
                  coverage.stale.length ? (
                    <div className='text-muted-foreground border-t pt-3 text-xs sm:col-span-3'>
                      {coverage.missingNodes.length ? (
                        <p>
                          {t('evaluations.uncoveredNodes')}:{' '}
                          {coverage.missingNodes
                            .map((node) => node.label)
                            .join('、')}
                        </p>
                      ) : null}
                      {coverage.missingRoutes.length ? (
                        <p>
                          {t('evaluations.uncoveredRoutes')}:{' '}
                          {coverage.missingRoutes
                            .map(
                              (route) => `${route.nodeLabel} → ${route.label}`,
                            )
                            .join('、')}
                        </p>
                      ) : null}
                      {coverage.stale.length ? (
                        <p className='text-destructive'>
                          {t('evaluations.staleAssertionTargets')}:{' '}
                          {coverage.stale.join('、')}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className='text-muted-foreground border-t pt-3 text-xs sm:col-span-3'>
                      {t('evaluations.coverageComplete')}
                    </p>
                  )}
                </div>
                <div className='grid gap-5 min-[1900px]:grid-cols-[minmax(0,1fr)_18rem]'>
                  <div className='flex flex-col gap-2'>
                    <div className='flex items-center justify-between'>
                      <div className='text-muted-foreground text-xs font-medium tracking-wider uppercase'>
                        Cases
                      </div>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => setShowArchivedCases((value) => !value)}
                      >
                        {showArchivedCases
                          ? t('evaluations.hideArchived')
                          : t('evaluations.showArchived')}
                      </Button>
                    </div>
                    {cases.isLoading ? (
                      <div className='text-muted-foreground flex items-center gap-2 py-6 text-sm'>
                        <Spinner /> {t('evaluations.loadingCases')}
                      </div>
                    ) : null}
                    {cases.data?.map((item) => (
                      <div
                        key={item.id}
                        className='flex items-center gap-3 rounded-lg border px-3 py-3'
                      >
                        <span className='bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md text-xs font-medium'>
                          {item.position + 1}
                        </span>
                        <div className='min-w-0 flex-1'>
                          <div className='truncate text-sm font-medium'>
                            {item.name}
                          </div>
                          <div className='text-muted-foreground truncate text-xs'>
                            {item.description ||
                              t('evaluations.outputAssertions')}
                          </div>
                        </div>
                        <Badge variant={item.enabled ? 'secondary' : 'outline'}>
                          {item.archived
                            ? t('evaluations.archived')
                            : item.enabled
                              ? t('evaluations.enabled')
                              : t('evaluations.disabled')}
                        </Badge>
                        {item.archived ? (
                          <Button
                            variant='outline'
                            size='sm'
                            onClick={() => void restoreCase(item)}
                          >
                            {t('evaluations.restore')}
                          </Button>
                        ) : null}
                        <div className='ml-auto flex flex-wrap items-center justify-end gap-1'>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t(
                              item.enabled
                                ? 'evaluations.disableCase'
                                : 'evaluations.enableCase',
                              { name: item.name },
                            )}
                            onClick={() => void updateCaseEnabled(item)}
                          >
                            <PowerIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t('evaluations.moveCaseUp', {
                              name: item.name,
                            })}
                            disabled={item.position === 0}
                            onClick={() => void moveCase(item, -1)}
                          >
                            <ArrowUpIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t('evaluations.moveCaseDown', {
                              name: item.name,
                            })}
                            disabled={
                              item.position === (cases.data?.length ?? 1) - 1
                            }
                            onClick={() => void moveCase(item, 1)}
                          >
                            <ArrowDownIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t('evaluations.copyCase', {
                              name: item.name,
                            })}
                            onClick={() => void duplicateCase(item)}
                          >
                            <CopyIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t('evaluations.editCaseAria', {
                              name: item.name,
                            })}
                            onClick={() => openCaseEditor(item)}
                          >
                            <PencilIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={t('evaluations.deleteCaseAria', {
                              name: item.name,
                            })}
                            onClick={() => setDeleteCase(item)}
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      </div>
                    ))}
                    {!cases.isLoading && !cases.data?.length ? (
                      <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-7 text-center text-sm'>
                        {t('evaluations.noCases')}
                      </p>
                    ) : null}
                  </div>
                  <div className='border-border/70 bg-muted/20 rounded-xl border p-3.5 shadow-sm'>
                    <div className='mb-3 flex items-center justify-between'>
                      <div>
                        <span className='text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase'>
                          {t('evaluations.currentEvaluation')}
                        </span>
                        <p className='mt-0.5 text-sm font-semibold'>
                          {t('evaluations.runOverview')}
                        </p>
                      </div>
                      {activeRunId ? (
                        <Badge
                          className={
                            runDetail.data
                              ? RUN_OUTCOME_STYLE[runOutcome(runDetail.data)]
                                  .badge
                              : undefined
                          }
                          variant='outline'
                        >
                          {runDetail.data
                            ? t(
                                `evaluations.outcomes.${runOutcome(runDetail.data)}`,
                              )
                            : `${completed}/${results.data?.length ?? 0}`}
                        </Badge>
                      ) : null}
                    </div>
                    {!activeRunId ? (
                      <p className='text-muted-foreground text-sm leading-6'>
                        {t('evaluations.runDescription')}
                      </p>
                    ) : null}
                    {runDetail.data
                      ? (() => {
                          const rate = runDetail.data.totalCases
                            ? Math.round(
                                (runDetail.data.passedCases /
                                  runDetail.data.totalCases) *
                                  100,
                              )
                            : 0;
                          const style =
                            RUN_OUTCOME_STYLE[runOutcome(runDetail.data)];
                          return (
                            <div className='bg-background/70 mb-4 rounded-lg border p-3'>
                              <div className='mb-2 flex items-end justify-between'>
                                <div>
                                  <span className='text-2xl font-semibold tracking-tight'>
                                    {rate}%
                                  </span>
                                  <span className='text-muted-foreground ml-1 text-xs'>
                                    {t('evaluations.passRate')}
                                  </span>
                                </div>
                                <span className='text-muted-foreground text-xs'>
                                  {runDetail.data.passedCases}/
                                  {runDetail.data.totalCases} Cases
                                </span>
                              </div>
                              <div className='bg-muted h-1.5 overflow-hidden rounded-full'>
                                <div
                                  className={`h-full rounded-full transition-all ${style.meter}`}
                                  style={{ width: `${rate}%` }}
                                />
                              </div>
                              <div className='mt-3 grid grid-cols-3 gap-2 text-center'>
                                <div>
                                  <div className='text-muted-foreground text-[10px] uppercase'>
                                    {t('evaluations.duration')}
                                  </div>
                                  <div className='mt-0.5 text-xs font-medium'>
                                    {formatDuration(runDetail.data.durationMs)}
                                  </div>
                                </div>
                                <div>
                                  <div className='text-muted-foreground text-[10px] uppercase'>
                                    {t('evaluations.cost')}
                                  </div>
                                  <div className='mt-0.5 text-xs font-medium'>
                                    {formatCost(
                                      runDetail.data.estimatedCostMicrousd,
                                    )}
                                  </div>
                                </div>
                                <div>
                                  <div className='text-muted-foreground text-[10px] uppercase'>
                                    Token
                                  </div>
                                  <div className='mt-0.5 text-xs font-medium'>
                                    {formatNumber(runDetail.data.totalTokens)}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })()
                      : null}
                    <div className='flex flex-col gap-2'>
                      {results.data?.map((result) => (
                        <button
                          key={result.id}
                          type='button'
                          onClick={() => setSelectedResult(result)}
                          className='bg-background hover:bg-muted/60 rounded-md border px-2.5 py-2 text-left transition-colors'
                        >
                          <div className='flex items-center gap-2'>
                            <ResultIcon verdict={result.verdict} />
                            <span className='min-w-0 flex-1 truncate text-xs font-medium'>
                              {cases.data?.find(
                                (item) => item.id === result.evaluationCaseId,
                              )?.name ?? t('evaluations.case')}
                            </span>
                            <Badge
                              className={RESULT_STYLE[result.verdict]}
                              variant='outline'
                            >
                              {result.verdict}
                            </Badge>
                          </div>
                          {result.score !== null &&
                          result.score !== undefined ? (
                            <div className='text-muted-foreground mt-1 pl-6 text-xs'>
                              {t('evaluations.score', {
                                score: Math.round(result.score * 100),
                              })}
                            </div>
                          ) : null}
                          {result.failureReason ? (
                            <div className='text-destructive mt-1 text-xs'>
                              {result.failureReason}
                            </div>
                          ) : null}
                        </button>
                      ))}
                    </div>
                    {activeRunId &&
                    results.isFetching &&
                    !results.data?.length ? (
                      <div className='text-muted-foreground mt-3 flex items-center gap-2 text-sm'>
                        <Spinner /> {t('evaluations.creatingRun')}
                      </div>
                    ) : null}
                    {activeRunId && results.data?.length ? (
                      <p className='text-muted-foreground mt-3 text-xs'>
                        {t('evaluations.runProgress', { passed, completed })}
                      </p>
                    ) : null}
                    <EvaluationTrends
                      runs={runHistory.data ?? []}
                      versions={versionSummary.data ?? []}
                    />
                    <div className='mt-5 border-t pt-4'>
                      <div className='mb-3 flex items-center justify-between'>
                        <div>
                          <div className='text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase'>
                            {t('evaluations.runHistory')}
                          </div>
                          <p className='text-muted-foreground mt-0.5 text-xs'>
                            {t('evaluations.lastThirtyRuns')}
                          </p>
                        </div>
                        <Badge variant='outline' className='text-[10px]'>
                          {runHistory.data?.length ?? 0}
                        </Badge>
                      </div>
                      <div className='flex max-h-72 flex-col gap-2 overflow-y-auto pr-0.5'>
                        {runHistory.data?.map((run) => {
                          const rate = run.totalCases
                            ? Math.round(
                                (run.passedCases / run.totalCases) * 100,
                              )
                            : 0;
                          const outcome = runOutcome(run);
                          const style = RUN_OUTCOME_STYLE[outcome];
                          return (
                            <button
                              key={run.id}
                              type='button'
                              onClick={() => setActiveRunId(run.id)}
                              className={`grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border p-2 text-left transition-colors ${run.id === activeRunId ? 'border-primary bg-primary/5 ring-primary/10 shadow-sm ring-1' : 'bg-background/60 hover:bg-background hover:shadow-sm'}`}
                            >
                              <div
                                className={`flex size-10 flex-col items-center justify-center rounded-md text-[10px] font-semibold ${style.badge}`}
                              >
                                <span className='text-sm leading-none'>
                                  {rate}
                                </span>
                                <span className='mt-0.5 opacity-75'>%</span>
                              </div>
                              <div className='min-w-0'>
                                <div className='flex items-center gap-2'>
                                  <span className='truncate text-xs font-medium'>
                                    {new Date(run.startedAt).toLocaleString()}
                                  </span>
                                  <span className='text-muted-foreground shrink-0 text-[10px]'>
                                    {t('evaluations.passed', {
                                      passed: run.passedCases,
                                      total: run.totalCases,
                                    })}
                                  </span>
                                </div>
                                <div className='text-muted-foreground mt-1 flex gap-2 text-[10px]'>
                                  <span>
                                    {formatCost(run.estimatedCostMicrousd)}
                                  </span>
                                  <span className='text-border'>·</span>
                                  <span>{formatDuration(run.durationMs)}</span>
                                </div>
                              </div>
                              <Badge className={style.badge} variant='outline'>
                                {t(`evaluations.outcomes.${outcome}`)}
                              </Badge>
                            </button>
                          );
                        })}
                        {!runHistory.data?.length ? (
                          <p className='text-muted-foreground text-xs'>
                            {t('evaluations.noRunHistory')}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {versionSummary.data && versionSummary.data.length > 1 ? (
                      <div className='mt-5 border-t pt-4'>
                        <div className='text-muted-foreground mb-3 text-[10px] font-semibold tracking-[0.16em] uppercase'>
                          {t('evaluations.versionComparison')}
                        </div>
                        <div className='grid gap-2'>
                          <Select
                            value={baselineVersion}
                            // The Select can clear its value with null, while this state uses undefined.
                            onValueChange={(value) =>
                              setBaselineVersion(value ?? undefined)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue
                                placeholder={t('evaluations.selectBaseline')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {versionSummary.data.map((version) => (
                                  <SelectItem
                                    key={versionKey(version)}
                                    value={versionKey(version)}
                                  >
                                    {version.releaseVersion}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          <Select
                            value={candidateVersion}
                            // Keep cleared Select values consistent with the optional state type.
                            onValueChange={(value) =>
                              setCandidateVersion(value ?? undefined)
                            }
                          >
                            <SelectTrigger>
                              <SelectValue
                                placeholder={t('evaluations.selectCandidate')}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {versionSummary.data.map((version) => (
                                  <SelectItem
                                    key={versionKey(version)}
                                    value={versionKey(version)}
                                  >
                                    {version.releaseVersion}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </div>
                        {baseline && candidate ? (
                          <>
                            <div className='text-muted-foreground mt-3 grid grid-cols-3 gap-y-1 text-xs'>
                              <span />
                              <span className='text-center'>
                                {baseline.releaseVersion}
                              </span>
                              <span className='text-center'>
                                {candidate.releaseVersion}
                              </span>
                              <span>{t('evaluations.passRate')}</span>
                              <span className='text-center'>
                                {versionPassRate(baseline)}%
                              </span>
                              <span className='text-center'>
                                {versionPassRate(candidate)}%
                              </span>
                              <span>{t('evaluations.cost')}</span>
                              <span className='text-center'>
                                {formatCost(baseline.estimatedCostMicrousd)}
                              </span>
                              <span className='text-center'>
                                {formatCost(candidate.estimatedCostMicrousd)}
                              </span>
                              <span>{t('evaluations.duration')}</span>
                              <span className='text-center'>
                                {formatDuration(baseline.totalDurationMs)}
                              </span>
                              <span className='text-center'>
                                {formatDuration(candidate.totalDurationMs)}
                              </span>
                            </div>
                            {versionDiff.data?.length ? (
                              <div className='mt-3 flex flex-col gap-1'>
                                {versionDiff.data.map((diff) => (
                                  <button
                                    type='button'
                                    key={diff.caseId}
                                    className='hover:bg-muted/60 focus-visible:ring-ring flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors outline-none focus-visible:ring-2'
                                    onClick={() => setSelectedVersionDiff(diff)}
                                  >
                                    <span className='truncate'>
                                      {diff.name}
                                    </span>
                                    <span className='flex shrink-0 items-center gap-1.5'>
                                      <Badge variant='outline'>
                                        {versionDiffLabel(diff, t)}
                                      </Badge>
                                      <ChevronRightIcon className='text-muted-foreground size-3.5' />
                                    </span>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <p className='text-muted-foreground mt-3 text-xs'>
                                {t('evaluations.noCaseDifferences')}
                              </p>
                            )}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      <VersionDiffDialog
        diff={selectedVersionDiff}
        comparison={versionCriteriaDiff.data}
        loading={versionCriteriaDiff.isLoading}
        baselineLabel={baseline?.releaseVersion ?? ''}
        candidateLabel={candidate?.releaseVersion ?? ''}
        nodeNames={Object.fromEntries(
          configuredWorkflowNodes.map((node) => [node.id, node.label]),
        )}
        routeNames={Object.fromEntries(
          configuredRoutes.map((route) => [
            `${route.nodeId}:${route.route}`,
            route.label,
          ]),
        )}
        onOpenChange={setSelectedVersionDiff}
      />

      <QualityGateDialog
        open={qualityGateOpen}
        qualityGate={qualityGate}
        suites={suites.data ?? []}
        onOpenChange={setQualityGateOpen}
        setQualityGate={setQualityGate}
        onSave={() => void saveQualityGate()}
      />

      <SuiteDialog
        open={suiteDialogOpen}
        suite={editingSuite}
        name={suiteName}
        description={suiteDescription}
        saving={saving}
        onOpenChange={setSuiteDialogOpen}
        onNameChange={setSuiteName}
        onDescriptionChange={setSuiteDescription}
        onSave={() => void saveSuite()}
      />

      <DeleteSuiteDialog
        suite={deleteSuite}
        saving={saving}
        onOpenChange={setDeleteSuite}
        onConfirm={() => void removeSuite()}
      />

      <DeleteCaseDialog
        evaluationCase={deleteCase}
        onOpenChange={setDeleteCase}
        onConfirm={() => void confirmDeleteCase()}
      />

      <CaseEditorDialog
        editor={{
          caseDialogOpen,
          setCaseDialogOpen,
          saving,
          editingCase,
          caseName,
          setCaseName,
          caseDescription,
          setCaseDescription,
          caseInput,
          setCaseInput,
          assertionDrafts,
          setAssertionDrafts,
          toolTrajectory,
          setToolTrajectory,
          nodeTrajectory,
          setNodeTrajectory,
          routeDrafts,
          setRouteDrafts,
          nodeOutputDrafts,
          setNodeOutputDrafts,
          nodeTextDrafts,
          setNodeTextDrafts,
          nodeToolDrafts,
          setNodeToolDrafts,
          fixtureDrafts,
          setFixtureDrafts,
          safetyDrafts,
          setSafetyDrafts,
          configuredTools,
          configuredWorkflowNodes,
          configuredRoutes,
          configuredRouteNodes,
          configuredAgentNodes,
          assertionsJson,
          saveCase,
        }}
      />

      <EvaluationImportDialog
        preview={testImport}
        suites={suites.data ?? []}
        suiteStrategy={suiteImportStrategy}
        caseStrategy={caseImportStrategy}
        importing={importing}
        onOpenChange={setTestImport}
        onSuiteStrategyChange={setSuiteImportStrategy}
        onCaseStrategyChange={setCaseImportStrategy}
        onConfirm={() => void confirmTestImport()}
      />

      <EvaluationResultDialog
        result={selectedResult}
        cases={cases.data ?? []}
        nodeNames={Object.fromEntries(
          configuredWorkflowNodes.map((node) => [node.id, node.label]),
        )}
        routeNames={Object.fromEntries(
          configuredRoutes.map((route) => [
            `${route.nodeId}:${route.route}`,
            route.label,
          ]),
        )}
        onOpenChange={setSelectedResult}
        onViewWorkflowRun={onViewWorkflowRun}
      />
    </div>
  );
}
