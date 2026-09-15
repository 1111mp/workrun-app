import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription as AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle as AlertDialogHeading,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
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
  ShieldCheckIcon,
  TestTubeDiagonalIcon,
  Trash2Icon,
  UploadIcon,
  XCircleIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
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
  summarizeEvaluationVersions,
  compareEvaluationVersions,
  listEvaluationSuites,
  reorderEvaluationCases,
  restoreEvaluationCase,
  startNextEvaluationCase,
  updateEvaluationCase,
  updateEvaluationSuite,
  updateEvaluationQualityGate,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationSuite,
  type EvaluationWorkflowSnapshot,
  type EvaluationVersionSummary,
  type EvaluationVersionCaseDiff,
  type EvaluationQualityGate,
} from '@/services/evaluation';
import { listTools, type ToolDefinition } from '@/services/tool';

type MatchAlgorithm = 'exact' | 'contains' | 'levenshtein';
type AssertionSubject = 'final_json' | 'final_text';
type AssertionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | MatchAlgorithm;
type VisualAssertion = {
  id: string;
  subject: AssertionSubject;
  path: string;
  operator: AssertionOperator;
  expected: string;
};
type ToolCallDraft = {
  id: string;
  name: string;
  args: string;
  count: number;
  assertResult: boolean;
  expectedResult: string;
};
type ToolTrajectoryDraft = {
  strictOrder: boolean;
  strictArgs: boolean;
  calls: ToolCallDraft[];
};
type ToolFixtureDraft = {
  id: string;
  tool: string;
  args: string;
  result: string;
};
type SafetyTarget = 'final_output' | 'tool_arguments' | 'tool_results';
type SafetyAssertionDraft = {
  id: string;
  target: SafetyTarget;
  fieldPaths: string;
  forbiddenText: string;
};

function workflowToolIds(snapshot: EvaluationWorkflowSnapshot) {
  const dsl = snapshot.dsl as {
    nodes?: Array<{ data?: { toolIds?: unknown } }>;
  };
  return new Set(
    dsl.nodes?.flatMap((node) =>
      Array.isArray(node.data?.toolIds)
        ? node.data.toolIds.filter((id): id is string => typeof id === 'string')
        : [],
    ) ?? [],
  );
}

function toolLabel(tool: ToolDefinition) {
  return tool.sourceName
    ? `${tool.sourceName} · ${tool.displayName}`
    : tool.displayName;
}

function selectedToolLabel(name: string, tools: ToolDefinition[]) {
  const tool = tools.find((candidate) => candidate.name === name);
  return tool ? toolLabel(tool) : name;
}
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
  { label: string; badge: string; rail: string; meter: string }
> = {
  passed: {
    label: '通过',
    badge:
      'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    rail: 'border-l-emerald-500',
    meter: 'bg-emerald-500',
  },
  failed: {
    label: '失败',
    badge: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
    rail: 'border-l-rose-500',
    meter: 'bg-rose-500',
  },
  running: {
    label: '运行中',
    badge: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    rail: 'border-l-sky-500',
    meter: 'bg-sky-500',
  },
  queued: {
    label: '等待中',
    badge:
      'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    rail: 'border-l-amber-500',
    meter: 'bg-amber-500',
  },
};

function runOutcome(run: {
  status: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
}): RunOutcome {
  if (run.status === 'queued') return 'queued';
  if (run.status === 'running') return 'running';
  if (run.failedCases > 0 || run.passedCases < run.totalCases) return 'failed';
  return 'passed';
}

function jsonObject(value: string, label: string) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return parsed;
}

function visualAssertions(value: unknown): VisualAssertion[] {
  const record = value as Record<string, unknown> | undefined;
  const assertions = Array.isArray(record?.assertions) ? record.assertions : [];
  const configured = assertions.flatMap<VisualAssertion>((assertion) => {
    if (!assertion || typeof assertion !== 'object') return [];
    const item = assertion as Record<string, unknown>;
    if (
      item.kind === 'json_path' &&
      typeof item.path === 'string' &&
      typeof item.operator === 'string'
    ) {
      return [
        {
          id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
          subject: 'final_json' as const,
          path: item.path,
          operator: item.operator as AssertionOperator,
          expected:
            typeof item.expected === 'string'
              ? item.expected
              : (JSON.stringify(item.expected) ?? ''),
        },
      ];
    }
    if (item.kind === 'text' && typeof item.expected === 'string') {
      return [
        {
          id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
          subject: 'final_text' as const,
          path: '',
          operator: item.algorithm as MatchAlgorithm,
          expected: item.expected,
        },
      ];
    }
    return [];
  });
  return configured;
}

function toolCallDraft(call?: Record<string, unknown>): ToolCallDraft {
  return {
    id: crypto.randomUUID(),
    name: typeof call?.name === 'string' ? call.name : '',
    args: JSON.stringify(call?.args ?? {}, null, 2),
    count: 1,
    assertResult: call?.expectedResponse !== undefined,
    expectedResult: JSON.stringify(call?.expectedResponse ?? {}, null, 2),
  };
}

function toolTrajectoryDraft(value: unknown): ToolTrajectoryDraft {
  const assertions = (value as { assertions?: unknown } | undefined)
    ?.assertions;
  const trajectory = Array.isArray(assertions)
    ? assertions.find(
        (assertion) =>
          assertion &&
          typeof assertion === 'object' &&
          (assertion as Record<string, unknown>).kind === 'tool_trajectory',
      )
    : undefined;
  const record = trajectory as Record<string, unknown> | undefined;
  return {
    strictOrder:
      record?.config !== null &&
      typeof record?.config === 'object' &&
      (record.config as Record<string, unknown>).strictOrder === false
        ? false
        : true,
    strictArgs:
      record?.config !== null &&
      typeof record?.config === 'object' &&
      (record.config as Record<string, unknown>).strictArgs === true,
    calls: Array.isArray(record?.tools)
      ? record.tools.flatMap((call) =>
          call && typeof call === 'object'
            ? [toolCallDraft(call as Record<string, unknown>)]
            : [],
        )
      : [],
  };
}

function toolFixtureDrafts(value: unknown): ToolFixtureDraft[] {
  const fixtures = (value as { toolFixtures?: unknown } | undefined)
    ?.toolFixtures;
  return Array.isArray(fixtures)
    ? fixtures.flatMap((fixture) => {
        if (!fixture || typeof fixture !== 'object') return [];
        const item = fixture as Record<string, unknown>;
        return [
          {
            id: crypto.randomUUID(),
            tool: typeof item.tool === 'string' ? item.tool : '',
            args: JSON.stringify(item.args ?? {}, null, 2),
            result: JSON.stringify(item.result ?? {}, null, 2),
          },
        ];
      })
    : [];
}

function safetyAssertionDrafts(value: unknown): SafetyAssertionDraft[] {
  const assertions = (value as { assertions?: unknown } | undefined)
    ?.assertions;
  return Array.isArray(assertions)
    ? assertions.flatMap((assertion) => {
        if (!assertion || typeof assertion !== 'object') return [];
        const item = assertion as Record<string, unknown>;
        if (
          item.kind !== 'safety' ||
          !['final_output', 'tool_arguments', 'tool_results'].includes(
            String(item.target),
          )
        )
          return [];
        return [
          {
            id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
            target: item.target as SafetyTarget,
            fieldPaths: Array.isArray(item.fieldPaths)
              ? item.fieldPaths.join('\n')
              : '',
            forbiddenText: Array.isArray(item.forbiddenText)
              ? item.forbiddenText.join('\n')
              : '',
          },
        ];
      })
    : [];
}

function safetyAssertions(drafts: SafetyAssertionDraft[]) {
  return drafts.map((draft) => ({
    kind: 'safety',
    id: draft.id,
    target: draft.target,
    fieldPaths: draft.fieldPaths
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
    forbiddenText: draft.forbiddenText
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
  }));
}

function trajectoryAssertion(draft: ToolTrajectoryDraft) {
  const tools = draft.calls.flatMap((call) => {
    if (!call.name.trim()) throw new Error('工具名称不能为空');
    const tool = {
      name: call.name.trim(),
      args: jsonObject(call.args, '工具参数'),
      ...(call.assertResult
        ? {
            expectedResponse: jsonObject(call.expectedResult, '预期工具返回值'),
          }
        : {}),
    };
    return Array.from({ length: call.count }, () => tool);
  });
  return tools.length
    ? {
        kind: 'tool_trajectory',
        id: crypto.randomUUID(),
        tools,
        config: {
          strictOrder: draft.strictOrder,
          strictArgs: draft.strictArgs,
        },
      }
    : undefined;
}

function fixturesFromDrafts(drafts: ToolFixtureDraft[]) {
  return {
    toolFixtures: drafts.map((fixture) => {
      if (!fixture.tool.trim()) throw new Error('fixture 工具名称不能为空');
      return {
        tool: fixture.tool.trim(),
        args: jsonObject(fixture.args, 'fixture 参数'),
        result: jsonObject(fixture.result, 'fixture 返回值'),
      };
    }),
  };
}

function expectationFromVisualAssertions(
  value: unknown,
  assertions: VisualAssertion[],
  trajectory: ToolTrajectoryDraft,
  safety: SafetyAssertionDraft[],
) {
  const source = value && typeof value === 'object' ? value : {};
  const { assertions: existing, ...base } = source as Record<string, unknown>;
  const preserved = Array.isArray(existing)
    ? existing.filter(
        (assertion) =>
          !(
            typeof assertion === 'object' &&
            assertion !== null &&
            ['json_path', 'text', 'tool_trajectory', 'safety'].includes(
              String((assertion as Record<string, unknown>).kind),
            )
          ),
      )
    : [];
  const toolAssertion = trajectoryAssertion(trajectory);
  return {
    ...base,
    assertions: [
      ...preserved,
      ...assertions.map((assertion) =>
        assertion.subject === 'final_json'
          ? {
              kind: 'json_path',
              id: assertion.id,
              path: assertion.path,
              operator: assertion.operator,
              expected: assertion.expected,
            }
          : {
              kind: 'text',
              id: assertion.id,
              algorithm: assertion.operator,
              expected: assertion.expected,
              threshold: assertion.operator === 'levenshtein' ? 0.8 : 1,
            },
      ),
      ...(toolAssertion ? [toolAssertion] : []),
      ...safetyAssertions(safety),
    ],
  };
}

function serializeVisualAssertions(
  assertions: VisualAssertion[],
  trajectory: ToolTrajectoryDraft,
  safety: SafetyAssertionDraft[],
) {
  const output = assertions.map((assertion) =>
    assertion.subject === 'final_json'
      ? {
          kind: 'json_path',
          id: assertion.id,
          path: assertion.path,
          operator: assertion.operator,
          expected: assertion.expected,
        }
      : {
          kind: 'text',
          id: assertion.id,
          algorithm: assertion.operator,
          expected: assertion.expected,
          threshold: assertion.operator === 'levenshtein' ? 0.8 : 1,
        },
  );
  // A partially typed JSON field must not make the controlled editor crash;
  // save still validates the exact same value before it reaches the backend.
  let toolAssertion: ReturnType<typeof trajectoryAssertion>;
  try {
    toolAssertion = trajectoryAssertion(trajectory);
  } catch {
    toolAssertion = undefined;
  }
  return [
    ...output,
    ...(toolAssertion ? [toolAssertion] : []),
    ...safetyAssertions(safety),
  ];
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
  const queryClient = useQueryClient();
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [baselineVersion, setBaselineVersion] = useState<string>();
  const [candidateVersion, setCandidateVersion] = useState<string>();
  const [showArchivedCases, setShowArchivedCases] = useState(false);
  const [selectedResult, setSelectedResult] = useState<EvaluationCaseResult>();
  const [suiteDialogOpen, setSuiteDialogOpen] = useState(false);
  const [qualityGateOpen, setQualityGateOpen] = useState(false);
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
  const [fixtureDrafts, setFixtureDrafts] = useState<ToolFixtureDraft[]>([]);
  const [safetyDrafts, setSafetyDrafts] = useState<SafetyAssertionDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const startingNext = useRef(false);
  const assertionsJson = JSON.stringify(
    serializeVisualAssertions(assertionDrafts, toolTrajectory, safetyDrafts),
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
      toast.success('已保存发布质量门', { toasterId: 'global' });
    } catch (error) {
      toast.error('无法保存发布质量门', {
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
  const toolCatalog = useQuery({
    queryKey: ['tool-catalog'],
    queryFn: listTools,
  });
  const configuredToolIds = workflowToolIds(workflowSnapshot);
  const configuredTools =
    toolCatalog.data?.filter((tool) => configuredToolIds.has(tool.id)) ?? [];

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
        toast.error('无法开始下一条评测用例', {
          toasterId: 'global',
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        startingNext.current = false;
      });
  }, [activeRunId, queryClient, results.data]);

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
      toast.error('无法保存评测集', {
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
      toast.error('无法删除评测集', {
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
    setFixtureDrafts(toolFixtureDrafts(item?.fixture));
    setSafetyDrafts(safetyAssertionDrafts(item?.expectation));
    setCaseDialogOpen(true);
  };

  const saveCase = async () => {
    if (
      !selectedSuite ||
      !caseName.trim() ||
      (!assertionDrafts.length && !toolTrajectory.calls.length)
    )
      return;
    setSaving(true);
    try {
      const expectation = expectationFromVisualAssertions(
        caseExpectation,
        assertionDrafts,
        toolTrajectory,
        safetyDrafts,
      );
      if (editingCase) {
        await updateEvaluationCase({
          id: editingCase.id,
          name: caseName.trim(),
          description: caseDescription.trim(),
          enabled: editingCase.enabled,
          targetAgentId: editingCase.targetAgentId ?? undefined,
          input: jsonObject(caseInput, '输入'),
          expectation,
          fixture: fixturesFromDrafts(fixtureDrafts),
        });
      } else {
        await createEvaluationCase({
          id: crypto.randomUUID(),
          suiteId: selectedSuite.id,
          name: caseName.trim(),
          description: caseDescription.trim(),
          position: cases.data?.length ?? 0,
          enabled: true,
          input: jsonObject(caseInput, '输入'),
          expectation,
          fixture: fixturesFromDrafts(fixtureDrafts),
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
      setFixtureDrafts([]);
      setSafetyDrafts([]);
    } catch (error) {
      toast.error('无法创建评测用例', {
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
      toast.error('无法开始评测', {
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
      toast.error('无法更新用例状态', {
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
      toast.error('无法调整用例顺序', {
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
        name: `${item.name}（副本）`,
        position: cases.data?.length ?? 0,
        targetAgentId: item.targetAgentId ?? undefined,
      });
      await refreshCases();
    } catch (error) {
      toast.error('无法复制用例', {
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
      toast.error('无法删除用例', {
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
      toast.error('无法恢复用例', {
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
    if (!selectedSuite) return;
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: 'ADK test file', extensions: ['test.json', 'json'] }],
      });
      if (!path) return;
      const source = JSON.parse(await readTextFile(path)) as {
        eval_cases?: unknown[];
      };
      if (!Array.isArray(source.eval_cases))
        throw new Error('未找到 eval_cases');
      for (const [index, sourceCase] of source.eval_cases.entries()) {
        const item = sourceCase as Record<string, unknown>;
        const extension = item.workrun as Record<string, unknown> | undefined;
        const turn = Array.isArray(item.conversation)
          ? (item.conversation[0] as Record<string, unknown> | undefined)
          : undefined;
        const response = turn?.final_response as
          | Record<string, unknown>
          | undefined;
        const text = (
          response?.parts as Array<Record<string, unknown>> | undefined
        )?.find((part) => typeof part.text === 'string')?.text;
        const tools = (
          turn?.intermediate_data as Record<string, unknown> | undefined
        )?.tool_uses;
        const adkAssertions = [
          ...(typeof text === 'string' && text.length > 0
            ? [
                {
                  kind: 'text',
                  id: crypto.randomUUID(),
                  algorithm: 'contains',
                  expected: text,
                  threshold: 1,
                },
              ]
            : []),
          ...(Array.isArray(tools) && tools.length > 0
            ? [
                {
                  kind: 'tool_trajectory',
                  id: crypto.randomUUID(),
                  tools,
                  config: { strictOrder: true, strictArgs: false },
                },
              ]
            : []),
        ];
        if (!extension?.expectation && !adkAssertions.length)
          throw new Error(`用例 ${index + 1} 缺少最终响应或工具轨迹`);
        await createEvaluationCase({
          id: crypto.randomUUID(),
          suiteId: selectedSuite.id,
          name: String(
            extension?.name ?? item.eval_id ?? `导入用例 ${index + 1}`,
          ),
          description: String(item.description ?? ''),
          position: (cases.data?.length ?? 0) + index,
          enabled: extension?.enabled !== false,
          input:
            (item.session_input as Record<string, unknown> | undefined)
              ?.state ?? {},
          // Standard ADK files do not know Workrun's assertion envelope.
          // Convert their response and tool uses into equivalent assertions.
          expectation: extension?.expectation ?? { assertions: adkAssertions },
          fixture: extension?.fixture ?? { toolFixtures: [] },
        });
      }
      await refreshCases();
      toast.success('已导入评测用例', { toasterId: 'global' });
    } catch (error) {
      toast.error('无法导入 .test.json', {
        toasterId: 'global',
        description: String(error),
      });
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
            <h2 className='text-xl font-semibold tracking-tight'>评测集</h2>
            <p className='text-muted-foreground mt-1 text-sm'>
              为当前工作流保存可重复运行的输入、断言和安全 fixture。
            </p>
          </div>
          <div className='flex gap-2'>
            <Button variant='outline' size='sm' onClick={openQualityGate}>
              <Settings2Icon data-icon='inline-start' /> 发布质量门
            </Button>
            <Button size='sm' onClick={() => openSuiteEditor()}>
              <PlusIcon data-icon='inline-start' /> 新建评测集
            </Button>
          </div>
        </div>

        <div className='grid min-h-108 min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]'>
          <aside className='bg-card rounded-xl border p-2'>
            {suites.isLoading ? (
              <div className='text-muted-foreground flex items-center gap-2 p-3 text-sm'>
                <Spinner /> 正在读取评测集
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
                先创建一个评测集。
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
                  <EmptyTitle>还没有选中的评测集</EmptyTitle>
                  <EmptyDescription>
                    创建评测集后，添加能代表关键路径的测试用例。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className='flex flex-col gap-5'>
                <div className='flex flex-wrap items-start justify-between gap-3 border-b pb-4'>
                  <div>
                    <h3 className='font-semibold'>{selectedSuite.name}</h3>
                    <p className='text-muted-foreground mt-1 text-sm'>
                      {selectedSuite.description || '尚未添加说明'}
                    </p>
                  </div>
                  <div className='flex flex-wrap justify-end gap-2'>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      title='导入 .test.json'
                      aria-label='导入 .test.json'
                      onClick={() => void importCases()}
                    >
                      <UploadIcon />
                    </Button>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      title='导出 .test.json'
                      aria-label='导出 .test.json'
                      onClick={() => void exportCases()}
                    >
                      <DownloadIcon />
                    </Button>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label='编辑评测集'
                      onClick={() => openSuiteEditor(selectedSuite)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant='ghost'
                      size='icon-sm'
                      aria-label='删除评测集'
                      onClick={() => setDeleteSuite(selectedSuite)}
                    >
                      <Trash2Icon />
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => openCaseEditor()}
                    >
                      <PlusIcon data-icon='inline-start' /> 添加用例
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
                      运行评测集
                    </Button>
                  </div>
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
                        {showArchivedCases ? '隐藏归档' : '查看归档'}
                      </Button>
                    </div>
                    {cases.isLoading ? (
                      <div className='text-muted-foreground flex items-center gap-2 py-6 text-sm'>
                        <Spinner /> 正在读取用例
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
                            {item.description || '输出断言'}
                          </div>
                        </div>
                        <Badge variant={item.enabled ? 'secondary' : 'outline'}>
                          {item.archived
                            ? '已归档'
                            : item.enabled
                              ? '已启用'
                              : '已停用'}
                        </Badge>
                        {item.archived ? (
                          <Button
                            variant='outline'
                            size='sm'
                            onClick={() => void restoreCase(item)}
                          >
                            恢复
                          </Button>
                        ) : null}
                        <div className='ml-auto flex flex-wrap items-center justify-end gap-1'>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`}
                            onClick={() => void updateCaseEnabled(item)}
                          >
                            <PowerIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={`上移 ${item.name}`}
                            disabled={item.position === 0}
                            onClick={() => void moveCase(item, -1)}
                          >
                            <ArrowUpIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={`下移 ${item.name}`}
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
                            aria-label={`复制 ${item.name}`}
                            onClick={() => void duplicateCase(item)}
                          >
                            <CopyIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={`编辑 ${item.name}`}
                            onClick={() => openCaseEditor(item)}
                          >
                            <PencilIcon />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon-sm'
                            aria-label={`删除 ${item.name}`}
                            onClick={() => setDeleteCase(item)}
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      </div>
                    ))}
                    {!cases.isLoading && !cases.data?.length ? (
                      <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-7 text-center text-sm'>
                        尚无用例。先添加一个能验证关键行为的输入和预期输出。
                      </p>
                    ) : null}
                  </div>
                  <div className='border-border/70 bg-muted/20 rounded-xl border p-3.5 shadow-sm'>
                    <div className='mb-3 flex items-center justify-between'>
                      <div>
                        <span className='text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase'>
                          当前评测
                        </span>
                        <p className='mt-0.5 text-sm font-semibold'>运行概览</p>
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
                            ? RUN_OUTCOME_STYLE[runOutcome(runDetail.data)]
                                .label
                            : `${completed}/${results.data?.length ?? 0}`}
                        </Badge>
                      ) : null}
                    </div>
                    {!activeRunId ? (
                      <p className='text-muted-foreground text-sm leading-6'>
                        运行会冻结当前工作流与用例配置，并在 Test Mode
                        中逐条执行。
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
                                    通过率
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
                                    耗时
                                  </div>
                                  <div className='mt-0.5 text-xs font-medium'>
                                    {formatDuration(runDetail.data.durationMs)}
                                  </div>
                                </div>
                                <div>
                                  <div className='text-muted-foreground text-[10px] uppercase'>
                                    成本
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
                              )?.name ?? '评测用例'}
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
                              得分 {Math.round(result.score * 100)}%
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
                        <Spinner /> 正在创建运行记录
                      </div>
                    ) : null}
                    {activeRunId && results.data?.length ? (
                      <p className='text-muted-foreground mt-3 text-xs'>
                        通过 {passed} / {completed}
                        ；完成当前用例后会自动继续下一条。
                      </p>
                    ) : null}
                    <div className='mt-5 border-t pt-4'>
                      <div className='mb-3 flex items-center justify-between'>
                        <div>
                          <div className='text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase'>
                            运行历史
                          </div>
                          <p className='text-muted-foreground mt-0.5 text-xs'>
                            最近 30 次快照
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
                                    {run.passedCases}/{run.totalCases} 通过
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
                                {style.label}
                              </Badge>
                            </button>
                          );
                        })}
                        {!runHistory.data?.length ? (
                          <p className='text-muted-foreground text-xs'>
                            尚无历史运行。
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {versionSummary.data && versionSummary.data.length > 1 ? (
                      <div className='mt-5 border-t pt-4'>
                        <div className='text-muted-foreground mb-3 text-[10px] font-semibold tracking-[0.16em] uppercase'>
                          版本比较
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
                              <SelectValue placeholder='选择基线版本' />
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
                              <SelectValue placeholder='选择候选版本' />
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
                              <span>通过率</span>
                              <span className='text-center'>
                                {versionPassRate(baseline)}%
                              </span>
                              <span className='text-center'>
                                {versionPassRate(candidate)}%
                              </span>
                              <span>成本</span>
                              <span className='text-center'>
                                {formatCost(baseline.estimatedCostMicrousd)}
                              </span>
                              <span className='text-center'>
                                {formatCost(candidate.estimatedCostMicrousd)}
                              </span>
                              <span>耗时</span>
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
                                  <div
                                    key={diff.caseId}
                                    className='flex justify-between gap-2 text-xs'
                                  >
                                    <span className='truncate'>
                                      {diff.name}
                                    </span>
                                    <Badge variant='outline'>
                                      {versionDiffLabel(diff)}
                                    </Badge>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className='text-muted-foreground mt-3 text-xs'>
                                没有可报告的 Case 差异。
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

      <Dialog open={qualityGateOpen} onOpenChange={setQualityGateOpen}>
        <DialogContent className='max-w-2xl! gap-0 overflow-hidden p-0'>
          <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-amber-500/12 to-violet-500/10 px-6 py-6 pr-14'>
            <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(38_92%_50%/0.14)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
            <div className='relative flex items-start gap-3'>
              <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 text-amber-700 shadow-sm dark:text-amber-300'>
                <ShieldCheckIcon className='size-5' />
              </div>
              <div>
                <DialogTitle className='text-lg'>发布质量门</DialogTitle>
                <DialogDescription className='mt-1 max-w-xl leading-5'>
                  为 Workflow
                  设定发布前必须满足的评测标准；未通过时仍需明确确认旁路。
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
            <FieldGroup className='gap-7'>
              <Field orientation='horizontal'>
                <Checkbox
                  id='gate-require-evaluation'
                  checked={qualityGate.requireEvaluation}
                  onCheckedChange={(checked) =>
                    setQualityGate((current) => ({
                      ...current,
                      requireEvaluation: checked === true,
                    }))
                  }
                />
                <FieldLabel htmlFor='gate-require-evaluation'>
                  必须至少有一次评测
                </FieldLabel>
              </Field>
              <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
                <FieldLegend>总体阈值</FieldLegend>
                <FieldDescription>
                  以下指标基于最近一次评测运行。
                </FieldDescription>
                <div className='mt-4 grid gap-4 sm:grid-cols-3'>
                  <Field>
                    <FieldLabel>最低通过率（%）</FieldLabel>
                    <Input
                      type='number'
                      min={0}
                      max={100}
                      value={
                        qualityGate.minPassRate == null
                          ? ''
                          : qualityGate.minPassRate * 100
                      }
                      onChange={(event) =>
                        setQualityGate((current) => ({
                          ...current,
                          minPassRate:
                            event.target.value === ''
                              ? null
                              : Number(event.target.value) / 100,
                        }))
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>最大成本（USD）</FieldLabel>
                    <Input
                      type='number'
                      min={0}
                      step='0.01'
                      value={
                        qualityGate.maxCostMicrousd == null
                          ? ''
                          : qualityGate.maxCostMicrousd / 1_000_000
                      }
                      onChange={(event) =>
                        setQualityGate((current) => ({
                          ...current,
                          maxCostMicrousd:
                            event.target.value === ''
                              ? null
                              : Math.round(
                                  Number(event.target.value) * 1_000_000,
                                ),
                        }))
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>最大耗时（秒）</FieldLabel>
                    <Input
                      type='number'
                      min={0}
                      value={
                        qualityGate.maxDurationMs == null
                          ? ''
                          : qualityGate.maxDurationMs / 1000
                      }
                      onChange={(event) =>
                        setQualityGate((current) => ({
                          ...current,
                          maxDurationMs:
                            event.target.value === ''
                              ? null
                              : Math.round(Number(event.target.value) * 1000),
                        }))
                      }
                    />
                  </Field>
                </div>
              </FieldSet>
              <FieldSet className='rounded-xl border p-4 sm:p-5'>
                <FieldLegend>发布必检评测集</FieldLegend>
                <FieldDescription>
                  列出的 Suite 最近一次运行必须通过。
                </FieldDescription>
                <FieldGroup className='mt-2 gap-2'>
                  {suites.data?.map((suite) => (
                    <Field key={suite.id} orientation='horizontal'>
                      <Checkbox
                        id={`gate-suite-${suite.id}`}
                        checked={qualityGate.requiredSuiteIds.includes(
                          suite.id,
                        )}
                        onCheckedChange={(checked) =>
                          setQualityGate((current) => ({
                            ...current,
                            requiredSuiteIds:
                              checked === true
                                ? [...current.requiredSuiteIds, suite.id]
                                : current.requiredSuiteIds.filter(
                                    (id) => id !== suite.id,
                                  ),
                          }))
                        }
                      />
                      <Label htmlFor={`gate-suite-${suite.id}`}>
                        {suite.name}
                      </Label>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
          </div>
          <DialogFooter className='border-t px-6 py-4'>
            <Button variant='outline' onClick={() => setQualityGateOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void saveQualityGate()}>保存质量门</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={suiteDialogOpen} onOpenChange={setSuiteDialogOpen}>
        <DialogContent
          className='max-w-xl! gap-0 overflow-hidden p-0'
          showCloseButton={!saving}
        >
          <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/12 to-violet-500/10 px-6 py-6 pr-14'>
            <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.16)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
            <div className='relative flex items-start gap-3'>
              <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
                <BeakerIcon className='size-5' />
              </div>
              <div className='min-w-0'>
                <DialogTitle className='text-lg'>
                  {editingSuite ? '编辑评测集' : '新建评测集'}
                </DialogTitle>
                <DialogDescription className='mt-1 max-w-md leading-5'>
                  将一组会共同运行的回归用例放入同一个评测集，方便持续验证工作流的关键路径。
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='px-6 py-6'>
            <FieldSet className='bg-muted/20 rounded-xl border p-4 sm:p-5'>
              <FieldLegend>评测集详情</FieldLegend>
              <FieldDescription>
                使用清晰的名称区分不同的回归场景；说明可帮助团队理解覆盖范围。
              </FieldDescription>
              <FieldGroup className='mt-5 gap-5'>
                <Field>
                  <FieldLabel htmlFor='evaluation-suite-name'>名称</FieldLabel>
                  <Input
                    id='evaluation-suite-name'
                    value={suiteName}
                    placeholder='例如：客户信息查询回归'
                    onChange={(event) => setSuiteName(event.target.value)}
                    autoFocus
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor='evaluation-suite-description'>
                    说明 <span className='text-muted-foreground font-normal'>（可选）</span>
                  </FieldLabel>
                  <Textarea
                    id='evaluation-suite-description'
                    className='min-h-24 resize-y'
                    placeholder='例如：覆盖 CRM 查询、权限边界与敏感信息保护。'
                    value={suiteDescription}
                    onChange={(event) =>
                      setSuiteDescription(event.target.value)
                    }
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
          </div>
          <DialogFooter className='border-t px-6 py-4'>
            <Button
              variant='outline'
              disabled={saving}
              onClick={() => setSuiteDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={!suiteName.trim() || saving}
              onClick={() => void saveSuite()}
            >
              {saving ? <Spinner /> : null}{' '}
              {editingSuite ? '保存评测集' : '创建评测集'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteSuite)}
        onOpenChange={(open) => !open && setDeleteSuite(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogHeading>删除评测集？</AlertDialogHeading>
            <AlertDialogBody>
              将删除“{deleteSuite?.name}”中的 Case、评测运行及评测结果；关联的
              Workflow Run 历史会保留。
            </AlertDialogBody>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={saving}
              onClick={() => void removeSuite()}
            >
              {saving ? <Spinner /> : null} 删除评测集
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deleteCase)}
        onOpenChange={(open) => !open && setDeleteCase(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogHeading>删除评测用例？</AlertDialogHeading>
            <AlertDialogBody>
              将删除“{deleteCase?.name}
              ”。该用例会从评测集移除，但不会影响已有运行的冻结证据。
            </AlertDialogBody>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteCase()}>
              删除用例
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={caseDialogOpen} onOpenChange={setCaseDialogOpen}>
        <DialogContent
          className='max-w-3xl! gap-0 overflow-hidden p-0'
          showCloseButton={!saving}
        >
          <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/12 to-violet-500/10 px-6 py-6 pr-14'>
            <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.16)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
            <div className='relative flex items-start gap-3'>
              <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
                <TestTubeDiagonalIcon className='size-5' />
              </div>
              <div className='min-w-0'>
                <DialogTitle className='text-lg'>
                  {editingCase ? '编辑评测用例' : '添加评测用例'}
                </DialogTitle>
                <DialogDescription className='mt-1 max-w-xl leading-5'>
                  为工作流定义可重复运行的输入、预期输出和工具模拟结果。
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
            <FieldGroup className='gap-7'>
              <FieldSet>
                <FieldLegend>用例详情</FieldLegend>
                <FieldDescription>
                  为这条回归用例添加清晰的名称和说明。
                </FieldDescription>
                <FieldGroup className='gap-5'>
                  <Field>
                    <FieldLabel htmlFor='evaluation-case-name'>名称</FieldLabel>
                    <Input
                      id='evaluation-case-name'
                      value={caseName}
                      onChange={(event) => setCaseName(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor='evaluation-case-description'>
                      说明
                    </FieldLabel>
                    <Textarea
                      id='evaluation-case-description'
                      className='min-h-20 resize-y'
                      value={caseDescription}
                      onChange={(event) =>
                        setCaseDescription(event.target.value)
                      }
                    />
                  </Field>
                </FieldGroup>
              </FieldSet>

              <FieldSet className='bg-muted/20 rounded-xl border p-4 sm:p-5'>
                <FieldLegend>工作流输入</FieldLegend>
                <FieldDescription>
                  输入会作为本次评测的初始工作流 State。
                </FieldDescription>
                <FieldGroup className='gap-5'>
                  <Field>
                    <FieldLabel htmlFor='evaluation-case-input'>
                      输入 JSON
                    </FieldLabel>
                    <Textarea
                      id='evaluation-case-input'
                      className='min-h-24 font-mono text-xs leading-5'
                      value={caseInput}
                      onChange={(event) => setCaseInput(event.target.value)}
                    />
                  </Field>
                </FieldGroup>
              </FieldSet>

              <FieldSet className='rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'>
                  <div>
                    <FieldLegend>验证规则</FieldLegend>
                    <FieldDescription>
                      每条规则独立判定；全部通过后用例才通过。
                    </FieldDescription>
                  </div>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() =>
                      setAssertionDrafts((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          subject: 'final_json',
                          path: '$.',
                          operator: 'equals',
                          expected: '',
                        },
                      ])
                    }
                  >
                    <PlusIcon data-icon='inline-start' /> 添加规则
                  </Button>
                </div>
                <FieldGroup className='mt-4 gap-3'>
                  {assertionDrafts.map((assertion, index) => (
                    <div
                      key={assertion.id}
                      className='bg-background rounded-lg border p-3'
                    >
                      <div className='mb-3 flex items-center justify-between'>
                        <span className='text-sm font-medium'>
                          规则 {index + 1}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={`删除规则 ${index + 1}`}
                          onClick={() =>
                            setAssertionDrafts((current) =>
                              current.filter(
                                (item) => item.id !== assertion.id,
                              ),
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                      <div className='grid gap-3 sm:grid-cols-2'>
                        <Field>
                          <FieldLabel>验证对象</FieldLabel>
                          <Select
                            value={assertion.subject}
                            items={[
                              { value: 'final_json', label: '最终输出字段' },
                              { value: 'final_text', label: '最终输出文本' },
                            ]}
                            onValueChange={(value) =>
                              setAssertionDrafts((current) =>
                                current.map((item) =>
                                  item.id === assertion.id
                                    ? {
                                        ...item,
                                        subject: value as AssertionSubject,
                                        path:
                                          value === 'final_json' ? '$.' : '',
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value='final_json'>
                                  最终输出字段
                                </SelectItem>
                                <SelectItem value='final_text'>
                                  最终输出文本
                                </SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        {assertion.subject === 'final_json' ? (
                          <Field>
                            <FieldLabel>字段路径</FieldLabel>
                            <Input
                              value={assertion.path}
                              placeholder='$.decision'
                              onChange={(event) =>
                                setAssertionDrafts((current) =>
                                  current.map((item) =>
                                    item.id === assertion.id
                                      ? { ...item, path: event.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </Field>
                        ) : null}
                        <Field>
                          <FieldLabel>判断方式</FieldLabel>
                          <Select
                            value={assertion.operator}
                            items={
                              assertion.subject === 'final_json'
                                ? [
                                    { value: 'equals', label: '等于' },
                                    { value: 'not_equals', label: '不等于' },
                                    { value: 'contains', label: '包含' },
                                    { value: 'not_contains', label: '不包含' },
                                    { value: 'exists', label: '字段存在' },
                                  ]
                                : [
                                    { value: 'exact', label: '精确匹配' },
                                    { value: 'contains', label: '包含文本' },
                                    {
                                      value: 'levenshtein',
                                      label: '文本相似度',
                                    },
                                  ]
                            }
                            onValueChange={(value) =>
                              setAssertionDrafts((current) =>
                                current.map((item) =>
                                  item.id === assertion.id
                                    ? {
                                        ...item,
                                        operator: value as AssertionOperator,
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {assertion.subject === 'final_json' ? (
                                  <>
                                    <SelectItem value='equals'>等于</SelectItem>
                                    <SelectItem value='not_equals'>
                                      不等于
                                    </SelectItem>
                                    <SelectItem value='contains'>
                                      包含
                                    </SelectItem>
                                    <SelectItem value='not_contains'>
                                      不包含
                                    </SelectItem>
                                    <SelectItem value='exists'>
                                      字段存在
                                    </SelectItem>
                                  </>
                                ) : (
                                  <>
                                    <SelectItem value='exact'>
                                      精确匹配
                                    </SelectItem>
                                    <SelectItem value='contains'>
                                      包含文本
                                    </SelectItem>
                                    <SelectItem value='levenshtein'>
                                      文本相似度
                                    </SelectItem>
                                  </>
                                )}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        {assertion.operator !== 'exists' ? (
                          <Field>
                            <FieldLabel>预期值</FieldLabel>
                            <Input
                              value={assertion.expected}
                              placeholder={
                                assertion.subject === 'final_json'
                                  ? '通过'
                                  : '预期文本'
                              }
                              onChange={(event) =>
                                setAssertionDrafts((current) =>
                                  current.map((item) =>
                                    item.id === assertion.id
                                      ? {
                                          ...item,
                                          expected: event.target.value,
                                        }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </Field>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {!assertionDrafts.length ? (
                    <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-5 text-center text-sm'>
                      添加一条规则来定义这个 Case 如何通过。
                    </p>
                  ) : null}
                </FieldGroup>
              </FieldSet>

              <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'>
                  <div>
                    <FieldLegend>安全断言</FieldLegend>
                    <FieldDescription>
                      检查最终输出、工具参数或工具结果中不含敏感字段与指定文本。
                    </FieldDescription>
                  </div>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() =>
                      setSafetyDrafts((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          target: 'final_output',
                          fieldPaths: '',
                          forbiddenText: '',
                        },
                      ])
                    }
                  >
                    <PlusIcon data-icon='inline-start' /> 添加安全规则
                  </Button>
                </div>
                <FieldGroup className='mt-4 gap-3'>
                  {safetyDrafts.map((rule, index) => (
                    <div
                      key={rule.id}
                      className='bg-background rounded-lg border p-3'
                    >
                      <div className='mb-3 flex items-center justify-between'>
                        <span className='text-sm font-medium'>
                          安全规则 {index + 1}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={`删除安全规则 ${index + 1}`}
                          onClick={() =>
                            setSafetyDrafts((current) =>
                              current.filter((item) => item.id !== rule.id),
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                      <div className='grid gap-3 sm:grid-cols-2'>
                        <Field>
                          <FieldLabel>检查目标</FieldLabel>
                          <Select
                            value={rule.target}
                            items={[
                              { value: 'final_output', label: '最终输出' },
                              { value: 'tool_arguments', label: '工具参数' },
                              { value: 'tool_results', label: '工具结果' },
                            ]}
                            onValueChange={(value) =>
                              setSafetyDrafts((current) =>
                                current.map((item) =>
                                  item.id === rule.id
                                    ? { ...item, target: value as SafetyTarget }
                                    : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                <SelectItem value='final_output'>
                                  最终输出
                                </SelectItem>
                                <SelectItem value='tool_arguments'>
                                  工具参数
                                </SelectItem>
                                <SelectItem value='tool_results'>
                                  工具结果
                                </SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>禁止字段路径（每行一条）</FieldLabel>
                          <Textarea
                            className='min-h-20 font-mono text-xs leading-5'
                            placeholder='$.customer.email'
                            value={rule.fieldPaths}
                            onChange={(event) =>
                              setSafetyDrafts((current) =>
                                current.map((item) =>
                                  item.id === rule.id
                                    ? {
                                        ...item,
                                        fieldPaths: event.target.value,
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                        <Field className='sm:col-span-2'>
                          <FieldLabel>禁止文本（每行一条）</FieldLabel>
                          <Textarea
                            className='min-h-20'
                            placeholder='secret-token'
                            value={rule.forbiddenText}
                            onChange={(event) =>
                              setSafetyDrafts((current) =>
                                current.map((item) =>
                                  item.id === rule.id
                                    ? {
                                        ...item,
                                        forbiddenText: event.target.value,
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                      </div>
                    </div>
                  ))}
                </FieldGroup>
              </FieldSet>

              <FieldSet className='rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'>
                  <div>
                    <FieldLegend>工具轨迹断言</FieldLegend>
                    <FieldDescription>
                      要求 Agent 调用指定工具；可校验参数、顺序和 fixture
                      返回值，防止未经工具调用直接给出结论。
                    </FieldDescription>
                  </div>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() =>
                      setToolTrajectory((current) => ({
                        ...current,
                        calls: [...current.calls, toolCallDraft()],
                      }))
                    }
                  >
                    <PlusIcon data-icon='inline-start' /> 添加调用
                  </Button>
                </div>
                <FieldGroup className='mt-4 gap-3'>
                  <div className='flex flex-wrap gap-x-5 gap-y-2'>
                    <Field orientation='horizontal'>
                      <Checkbox
                        id='evaluation-tool-strict-order'
                        checked={toolTrajectory.strictOrder}
                        onCheckedChange={(checked) =>
                          setToolTrajectory((current) => ({
                            ...current,
                            strictOrder: checked === true,
                          }))
                        }
                      />
                      <Label htmlFor='evaluation-tool-strict-order'>
                        严格调用顺序
                      </Label>
                    </Field>
                    <Field orientation='horizontal'>
                      <Checkbox
                        id='evaluation-tool-strict-args'
                        checked={toolTrajectory.strictArgs}
                        onCheckedChange={(checked) =>
                          setToolTrajectory((current) => ({
                            ...current,
                            strictArgs: checked === true,
                          }))
                        }
                      />
                      <Label htmlFor='evaluation-tool-strict-args'>
                        参数完全匹配
                      </Label>
                    </Field>
                  </div>
                  {toolTrajectory.calls.map((call, index) => (
                    <div
                      key={call.id}
                      className='bg-background rounded-lg border p-3'
                    >
                      <div className='mb-3 flex items-center justify-between'>
                        <span className='text-sm font-medium'>
                          预期调用 {index + 1}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={`删除预期调用 ${index + 1}`}
                          onClick={() =>
                            setToolTrajectory((current) => ({
                              ...current,
                              calls: current.calls.filter(
                                (item) => item.id !== call.id,
                              ),
                            }))
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                      <div className='grid gap-3 sm:grid-cols-2'>
                        <Field>
                          <FieldLabel>工具</FieldLabel>
                          <Select
                            value={call.name}
                            onValueChange={(value) =>
                              setToolTrajectory((current) => ({
                                ...current,
                                calls: current.calls.map((item) =>
                                  item.id === call.id
                                    ? { ...item, name: value ?? '' }
                                    : item,
                                ),
                              }))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder='选择当前 Workflow 的工具'>
                                {call.name
                                  ? selectedToolLabel(
                                      call.name,
                                      configuredTools,
                                    )
                                  : undefined}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {configuredTools.map((tool) => (
                                  <SelectItem key={tool.id} value={tool.name}>
                                    {toolLabel(tool)}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>调用次数</FieldLabel>
                          <Input
                            type='number'
                            min={1}
                            value={call.count}
                            onChange={(event) =>
                              setToolTrajectory((current) => ({
                                ...current,
                                calls: current.calls.map((item) =>
                                  item.id === call.id
                                    ? {
                                        ...item,
                                        count: Math.max(
                                          1,
                                          Number(event.target.value) || 1,
                                        ),
                                      }
                                    : item,
                                ),
                              }))
                            }
                          />
                        </Field>
                        <Field className='sm:col-span-2'>
                          <FieldLabel>预期参数 JSON</FieldLabel>
                          <Textarea
                            className='min-h-20 font-mono text-xs leading-5'
                            value={call.args}
                            onChange={(event) =>
                              setToolTrajectory((current) => ({
                                ...current,
                                calls: current.calls.map((item) =>
                                  item.id === call.id
                                    ? { ...item, args: event.target.value }
                                    : item,
                                ),
                              }))
                            }
                          />
                        </Field>
                        <Field
                          orientation='horizontal'
                          className='sm:col-span-2'
                        >
                          <Checkbox
                            id={`evaluation-tool-result-${call.id}`}
                            checked={call.assertResult}
                            onCheckedChange={(checked) =>
                              setToolTrajectory((current) => ({
                                ...current,
                                calls: current.calls.map((item) =>
                                  item.id === call.id
                                    ? {
                                        ...item,
                                        assertResult: checked === true,
                                      }
                                    : item,
                                ),
                              }))
                            }
                          />
                          <Label htmlFor={`evaluation-tool-result-${call.id}`}>
                            断言工具返回值
                          </Label>
                        </Field>
                        {call.assertResult ? (
                          <Field className='sm:col-span-2'>
                            <FieldLabel>预期 fixture 返回值 JSON</FieldLabel>
                            <Textarea
                              className='min-h-20 font-mono text-xs leading-5'
                              value={call.expectedResult}
                              onChange={(event) =>
                                setToolTrajectory((current) => ({
                                  ...current,
                                  calls: current.calls.map((item) =>
                                    item.id === call.id
                                      ? {
                                          ...item,
                                          expectedResult: event.target.value,
                                        }
                                      : item,
                                  ),
                                }))
                              }
                            />
                          </Field>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {!toolTrajectory.calls.length ? (
                    <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-5 text-center text-sm'>
                      添加预期调用以验证 Agent 的工具使用轨迹。
                    </p>
                  ) : null}
                </FieldGroup>
              </FieldSet>

              <FieldSet className='rounded-xl border border-dashed p-4 sm:p-5'>
                <FieldLegend>高级断言 JSON 预览</FieldLegend>
                <FieldDescription>
                  此 JSON 由上方规则实时生成，用于导出、审查和排查。
                </FieldDescription>
                <Field>
                  <FieldLabel htmlFor='evaluation-case-assertions'>
                    assertions JSON
                  </FieldLabel>
                  <Textarea
                    id='evaluation-case-assertions'
                    className='min-h-36 font-mono text-xs leading-5'
                    placeholder={
                      '[\n  {\n    "kind": "json_path",\n    "id": "decision-is-approved",\n    "path": "$.decision",\n    "operator": "equals",\n    "expected": "通过"\n  }\n]'
                    }
                    value={assertionsJson}
                    readOnly
                  />
                </Field>
              </FieldSet>

              <FieldSet>
                <FieldLegend>工具模拟</FieldLegend>
                <FieldDescription>
                  fixture 只允许声明 mock 结果；未 mock 的外部工具会被 Test Mode
                  阻止。
                </FieldDescription>
                <FieldGroup className='mt-4 gap-3'>
                  {fixtureDrafts.map((fixture, index) => (
                    <div key={fixture.id} className='rounded-lg border p-3'>
                      <div className='mb-3 flex items-center justify-between'>
                        <span className='text-sm font-medium'>
                          Fixture {index + 1}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={`删除 fixture ${index + 1}`}
                          onClick={() =>
                            setFixtureDrafts((current) =>
                              current.filter((item) => item.id !== fixture.id),
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                      <div className='grid gap-3 sm:grid-cols-2'>
                        <Field>
                          <FieldLabel>工具</FieldLabel>
                          <Select
                            value={fixture.tool}
                            onValueChange={(value) =>
                              setFixtureDrafts((current) =>
                                current.map((item) =>
                                  item.id === fixture.id
                                    ? { ...item, tool: value ?? '' }
                                    : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder='选择当前 Workflow 的工具'>
                                {fixture.tool
                                  ? selectedToolLabel(
                                      fixture.tool,
                                      configuredTools,
                                    )
                                  : undefined}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {configuredTools.map((tool) => (
                                  <SelectItem key={tool.id} value={tool.name}>
                                    {toolLabel(tool)}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>匹配参数 JSON</FieldLabel>
                          <Textarea
                            className='min-h-20 font-mono text-xs leading-5'
                            value={fixture.args}
                            onChange={(event) =>
                              setFixtureDrafts((current) =>
                                current.map((item) =>
                                  item.id === fixture.id
                                    ? { ...item, args: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                        <Field className='sm:col-span-2'>
                          <FieldLabel>返回值 JSON</FieldLabel>
                          <Textarea
                            className='min-h-20 font-mono text-xs leading-5'
                            value={fixture.result}
                            onChange={(event) =>
                              setFixtureDrafts((current) =>
                                current.map((item) =>
                                  item.id === fixture.id
                                    ? { ...item, result: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          />
                        </Field>
                      </div>
                    </div>
                  ))}
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() =>
                      setFixtureDrafts((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          tool: '',
                          args: '{}',
                          result: '{}',
                        },
                      ])
                    }
                  >
                    <PlusIcon data-icon='inline-start' /> 添加 fixture
                  </Button>
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setCaseDialogOpen(false)}>
              取消
            </Button>
            <Button
              disabled={
                !caseName.trim() ||
                (!assertionDrafts.length && !toolTrajectory.calls.length) ||
                saving
              }
              onClick={() => void saveCase()}
            >
              {saving ? <Spinner /> : null}{' '}
              {editingCase ? '保存修改' : '保存用例'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selectedResult)}
        onOpenChange={(open) => !open && setSelectedResult(undefined)}
      >
        <DialogContent className='max-w-4xl! gap-0 overflow-hidden p-0'>
          <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/12 to-violet-500/10 px-6 py-6 pr-14'>
            <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.16)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
            <div className='relative flex items-start gap-3'>
              <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
                <TestTubeDiagonalIcon className='size-5' />
              </div>
              <div className='min-w-0'>
                <DialogTitle className='text-lg'>
                  {cases.data?.find(
                    (item) => item.id === selectedResult?.evaluationCaseId,
                  )?.name ?? '评测结果'}
                </DialogTitle>
                <DialogDescription className='mt-1 max-w-xl leading-5'>
                  此结果来自冻结的 Case 与 Workflow 快照。
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
            {selectedResult ? (
              <div className='flex flex-col gap-4'>
                <div className='rounded-xl border border-violet-500/20 bg-violet-500/5 p-4'>
                  <div className='mb-3 flex items-center gap-2'>
                    <ResultIcon verdict={selectedResult.verdict} />
                    <span className='text-sm font-medium'>本次评测摘要</span>
                  </div>
                  <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                    <ResultMetric label='结果' value={selectedResult.verdict} />
                    <ResultMetric
                      label='得分'
                      value={
                        selectedResult.score !== null &&
                        selectedResult.score !== undefined
                          ? `${Math.round(selectedResult.score * 100)}%`
                          : '—'
                      }
                    />
                    <ResultMetric
                      label='耗时'
                      value={formatDuration(selectedResult.durationMs)}
                    />
                    <ResultMetric
                      label='成本'
                      value={formatCost(selectedResult.estimatedCostMicrousd)}
                    />
                  </div>
                </div>
                {selectedResult.failureReason ? (
                  <div className='border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm'>
                    {selectedResult.failureReason}
                  </div>
                ) : null}
                <FieldSet className='rounded-xl border p-4 sm:p-5'>
                  <FieldLegend>实际输出</FieldLegend>
                  <FieldDescription>
                    冻结运行中 Agent 最终产生的输出。
                  </FieldDescription>
                  <ResultValue value={selectedResult.actualOutput} />
                </FieldSet>
                <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
                  <FieldLegend>断言判定</FieldLegend>
                  <FieldDescription>
                    每条规则独立评分；所有规则通过，Case 才会通过。
                  </FieldDescription>
                  <ResultCriteria
                    value={selectedResult.criteriaResults}
                    expectation={
                      cases.data?.find(
                        (item) => item.id === selectedResult.evaluationCaseId,
                      )?.expectation
                    }
                  />
                </FieldSet>
                <FieldSet className='rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5'>
                  <FieldLegend>工具轨迹</FieldLegend>
                  <FieldDescription>
                    工具轨迹断言与实际调用证据（已脱敏）。
                  </FieldDescription>
                  <ResultTrace
                    value={selectedResult.normalizedTrace}
                    configured={hasToolTrajectoryAssertion(
                      selectedResult.criteriaResults,
                    )}
                  />
                </FieldSet>
                {/* Keep raw evidence available for debugging without making it the primary reading path. */}
                <details className='rounded-lg border px-3 py-2 text-xs'>
                  <summary className='cursor-pointer font-medium'>
                    查看原始评测证据
                  </summary>
                  <div className='mt-3 flex flex-col gap-3'>
                    <ResultJson
                      title='评分明细 JSON'
                      value={selectedResult.criteriaResults}
                    />
                    <ResultJson
                      title='工具轨迹 JSON'
                      value={selectedResult.normalizedTrace}
                    />
                  </div>
                </details>
              </div>
            ) : null}
          </div>
          <DialogFooter className='border-t px-6 py-4'>
            <Button
              variant='outline'
              onClick={() => setSelectedResult(undefined)}
            >
              关闭
            </Button>
            {selectedResult?.workflowRunId ? (
              <Button
                onClick={() => {
                  onViewWorkflowRun(selectedResult.workflowRunId!);
                  setSelectedResult(undefined);
                }}
              >
                查看运行输出
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ResultJson({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className='mb-1 text-xs font-medium tracking-wider uppercase'>
        {title}
      </div>
      <pre className='bg-muted max-h-52 overflow-auto rounded-lg p-3 text-xs leading-5 break-words whitespace-pre-wrap'>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function ResultMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className='text-muted-foreground text-[11px]'>{label}</div>
      <div className='mt-0.5 text-sm font-medium'>{value}</div>
    </div>
  );
}

function ResultValue({ value }: { value: unknown }) {
  const text = (value as { text?: unknown } | undefined)?.text;
  return (
    <pre className='bg-muted mt-3 max-h-48 overflow-auto rounded-lg p-3 text-xs leading-5 break-words whitespace-pre-wrap'>
      {typeof text === 'string' ? text : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ResultCriteria({
  value,
  expectation,
}: {
  value: unknown;
  expectation?: unknown;
}) {
  const criteria = Array.isArray(value)
    ? (value as Array<Record<string, unknown>>)
    : [];
  return (
    <div className='mt-3 flex flex-col gap-2'>
      {criteria.map((item, index) => {
        const passed = item.passed === true;
        return (
          <div
            key={`${String(item.criterion)}-${index}`}
            className='bg-background rounded-lg border p-3'
          >
            <div className='flex items-center gap-2'>
              <span
                className={passed ? 'text-emerald-600' : 'text-destructive'}
              >
                {passed ? '通过' : '失败'}
              </span>
              <span className='min-w-0 flex-1 truncate text-sm font-medium'>
                {criterionLabel(item, expectation)}
              </span>
              <span className='text-muted-foreground text-xs'>
                {Math.round(Number(item.score ?? 0) * 100)}%
              </span>
            </div>
            <div className='text-muted-foreground mt-2 grid gap-1 text-xs'>
              <span>预期：{renderEvidence(item.expected)}</span>
              <span>实际：{renderEvidence(item.actual)}</span>
            </div>
          </div>
        );
      })}
      {!criteria.length ? (
        <p className='text-muted-foreground text-sm'>
          此运行没有可用的断言评分明细。
        </p>
      ) : null}
    </div>
  );
}

function ResultTrace({
  value,
  configured,
}: {
  value: unknown;
  configured: boolean;
}) {
  const trace = value as { toolUses?: unknown[] } | undefined;
  const tools = Array.isArray(trace?.toolUses) ? trace.toolUses : [];
  return (
    <div className='mt-3'>
      {tools.length ? (
        <div className='flex flex-col gap-2'>
          {tools.map((tool, index) => (
            <pre
              key={index}
              className='bg-background overflow-auto rounded-lg border p-3 text-xs'
            >
              {JSON.stringify(tool, null, 2)}
            </pre>
          ))}
        </div>
      ) : (
        <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
          {configured
            ? '已配置工具轨迹断言，但本次运行没有工具调用。'
            : '未配置工具轨迹断言。'}
        </p>
      )}
    </div>
  );
}

function hasToolTrajectoryAssertion(value: unknown) {
  return (
    Array.isArray(value) &&
    value.some(
      (criterion) =>
        typeof criterion === 'object' &&
        criterion !== null &&
        String((criterion as Record<string, unknown>).criterion).startsWith(
          'toolTrajectory:',
        ),
    )
  );
}

function renderEvidence(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function criterionLabel(
  criterion: Record<string, unknown>,
  expectation?: unknown,
) {
  const id = String(criterion.criterion ?? '');
  if (id.startsWith('jsonPath:')) {
    const path = (criterion.expected as Record<string, unknown> | undefined)
      ?.path;
    const legacyPath = Array.isArray(
      (expectation as Record<string, unknown> | undefined)?.assertions,
    )
      ? (
          (expectation as Record<string, unknown>).assertions as Array<
            Record<string, unknown>
          >
        ).find((assertion) => assertion.id === id.slice('jsonPath:'.length))
          ?.path
      : undefined;
    return typeof path === 'string'
      ? `输出字段 ${path}`
      : typeof legacyPath === 'string'
        ? `输出字段 ${legacyPath}`
        : '输出字段断言';
  }
  if (id.startsWith('text:')) return '最终输出文本';
  if (id.startsWith('toolTrajectory:')) return '工具轨迹';
  if (id.startsWith('safety:')) return '安全断言';
  return '断言';
}

function formatNumber(value?: number | null) {
  return typeof value === 'number'
    ? new Intl.NumberFormat().format(value)
    : '—';
}

function formatCost(value?: number | null) {
  return typeof value === 'number' ? `$${(value / 1_000_000).toFixed(4)}` : '—';
}

function formatDuration(value?: number | null) {
  return typeof value === 'number' ? `${(value / 1000).toFixed(1)}s` : '—';
}

function versionKey(version: EvaluationVersionSummary) {
  return `${version.releaseId ?? 'draft'}:${version.releaseVersion}`;
}

function versionPassRate(version: EvaluationVersionSummary) {
  return version.totalCases
    ? Math.round((version.passedCases / version.totalCases) * 100)
    : 0;
}

function versionDiffLabel(diff: EvaluationVersionCaseDiff) {
  return (
    {
      added: '新增 Case',
      removed: '仅基线存在',
      regressed: '新增失败',
      fixed: '已修复',
      persistent_failure: '持续失败',
    } as const
  )[diff.kind];
}

function adkTestFile(suite: EvaluationSuite, cases: EvaluationCase[]) {
  return {
    eval_set_id: suite.id,
    name: suite.name,
    description: suite.description,
    eval_cases: cases.map((item) => {
      const expectation = item.expectation as Record<string, unknown>;
      const textAssertion = Array.isArray(expectation.assertions)
        ? (expectation.assertions.find(
            (rule) => (rule as Record<string, unknown>)?.kind === 'text',
          ) as Record<string, unknown> | undefined)
        : undefined;
      const trajectory = Array.isArray(expectation.assertions)
        ? (expectation.assertions.find(
            (rule) =>
              (rule as Record<string, unknown>)?.kind === 'tool_trajectory',
          ) as Record<string, unknown> | undefined)
        : undefined;
      return {
        eval_id: item.id,
        description: item.description,
        conversation: [
          {
            invocation_id: item.id,
            user_content: {
              role: 'user',
              parts: [{ text: JSON.stringify(item.input) }],
            },
            final_response: textAssertion?.expected
              ? { role: 'model', parts: [{ text: textAssertion.expected }] }
              : undefined,
            intermediate_data: trajectory
              ? { tool_uses: trajectory.tools ?? [] }
              : undefined,
          },
        ],
        session_input: { state: item.input },
        workrun: {
          name: item.name,
          enabled: item.enabled,
          expectation: item.expectation,
          fixture: item.fixture,
        },
      };
    }),
  };
}
