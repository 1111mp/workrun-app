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
  DialogClose,
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
import type { TFunction } from 'i18next';
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
import { type ReactNode, useEffect, useRef, useState } from 'react';
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
  type EvaluationRunDetail,
  type EvaluationSuite,
  type EvaluationVersionCaseDiff,
  type EvaluationVersionCaseCriterionComparison,
  type EvaluationVersionCriterionDiff,
  type EvaluationVersionSummary,
  type EvaluationWorkflowSnapshot,
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

type ImportConflictStrategy = 'create' | 'overwrite' | 'skip';
type ImportedCase = {
  index: number;
  name: string;
  description: string;
  enabled: boolean;
  input: unknown;
  expectation: unknown;
  fixture: unknown;
  errors: string[];
};
type TestImportPreview = {
  suiteName: string;
  suiteDescription: string;
  cases: ImportedCase[];
  errors: string[];
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
type NodeTrajectoryDraft = {
  mustExecute: string[];
  mustNotExecute: string[];
  orderedNodes: string[];
  requireCompleted: boolean;
};
type RouteAssertionDraft = {
  id: string;
  nodeId: string;
  expectedRoute: string;
};
type NodeOutputAssertionDraft = {
  id: string;
  nodeId: string;
  path: string;
  operator: Exclude<AssertionOperator, MatchAlgorithm>;
  expected: string;
};
type NodeTextAssertionDraft = {
  id: string;
  nodeId: string;
  algorithm: MatchAlgorithm;
  expected: string;
};
type NodeToolAssertionDraft = { id: string; nodeId: string; toolName: string; count: number };
type WorkflowRouteOption = {
  nodeId: string;
  nodeLabel: string;
  route: string;
  label: string;
};
type ToolFixtureDraft = {
  id: string;
  nodeId: string;
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

function workflowEvaluationNodes(snapshot: EvaluationWorkflowSnapshot, t: TFunction) {
  const dsl = snapshot.dsl as {
    nodes?: Array<{
      id?: unknown;
      type?: unknown;
      data?: {
        name?: unknown;
        title?: unknown;
        workflowName?: unknown;
        label?: unknown;
      };
    }>;
  };
  return (dsl.nodes ?? []).flatMap((node) => {
    if (
      typeof node.id !== 'string' ||
      !node.id ||
      ['start', 'end', 'group'].includes(String(node.type))
    )
      return [];
    // Each node type stores its canvas name under a different key. Keep IDs
    // out of selectors whenever that human-facing name is available.
    const label =
      [
        node.data?.workflowName,
        node.data?.name,
        node.data?.title,
        node.data?.label,
      ]
        .find(
          (value): value is string =>
            typeof value === 'string' && Boolean(value.trim()),
        )
      ?.trim() ??
      t(`workflowEditor.inspector.nodes.${String(node.type ?? 'unknown')}`, {
        defaultValue: t('workflowEditor.inspector.untitledNode'),
      });
    return [{ id: node.id, label }];
  });
}

function workflowRoutes(
  snapshot: EvaluationWorkflowSnapshot,
): WorkflowRouteOption[] {
  const dsl = snapshot.dsl as {
    nodes?: Array<{
      id?: unknown;
      type?: unknown;
      data?: {
        label?: unknown;
        conditions?: Record<string, { label?: unknown }>;
        cases?: Array<{ id?: unknown; label?: unknown }>;
        defaultCase?: { label?: unknown };
      };
    }>;
  };
  return (dsl.nodes ?? []).flatMap<WorkflowRouteOption>((node) => {
    if (
      typeof node.id !== 'string' ||
      !['if_else', 'switch'].includes(String(node.type))
    )
      return [];
    const nodeId = node.id;
    const nodeLabel =
      typeof node.data?.label === 'string' && node.data.label.trim()
        ? node.data.label.trim()
        : nodeId;
    if (node.type === 'if_else') {
      return ['true', 'false'].map((route) => ({
        nodeId,
        nodeLabel,
        route,
        label:
          typeof node.data?.conditions?.[route]?.label === 'string'
            ? node.data.conditions[route].label
            : route,
      }));
    }
    return [
      ...(node.data?.cases ?? []).flatMap((item) =>
        typeof item.id === 'string'
          ? [
              {
                nodeId,
                nodeLabel,
                route: `case:${item.id}`,
                label: typeof item.label === 'string' ? item.label : item.id,
              },
            ]
          : [],
      ),
      {
        nodeId,
        nodeLabel,
        route: 'default',
        label:
          typeof node.data?.defaultCase?.label === 'string'
            ? node.data.defaultCase.label
            : 'default',
      },
    ];
  });
}

function workflowAgentNodes(snapshot: EvaluationWorkflowSnapshot) {
  const dsl = snapshot.dsl as {
    nodes?: Array<{ id?: unknown; type?: unknown; data?: { name?: unknown; label?: unknown } }>;
  };
  return (dsl.nodes ?? []).flatMap((node) => {
    if (typeof node.id !== 'string' || !['agent', 'codeact_agent', 'remote_agent'].includes(String(node.type))) return [];
    const label = [node.data?.name, node.data?.label].find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() ?? node.id;
    return [{ id: node.id, label }];
  });
}

function evaluationCoverage(
  cases: EvaluationCase[],
  nodes: Array<{ id: string; label: string }>,
  routes: WorkflowRouteOption[],
) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const routeKeys = new Set(routes.map((route) => `${route.nodeId}:${route.route}`));
  const coveredNodes = new Set<string>();
  const coveredRoutes = new Set<string>();
  const stale = new Set<string>();
  for (const item of cases.filter((item) => item.enabled && !item.archived)) {
    const assertions = (item.expectation as { assertions?: unknown } | undefined)?.assertions;
    if (!Array.isArray(assertions)) continue;
    for (const assertion of assertions) {
      if (!assertion || typeof assertion !== 'object') continue;
      const value = assertion as Record<string, unknown>;
      const nodeId = value.nodeId;
      if (typeof nodeId === 'string') {
        if (nodeIds.has(nodeId)) coveredNodes.add(nodeId);
        else stale.add(nodeId);
      }
      if (value.kind === 'node_trajectory') {
        for (const key of ['mustExecute', 'mustNotExecute', 'orderedNodes']) {
          const ids = value[key];
          if (Array.isArray(ids)) ids.forEach((id) => typeof id === 'string' && (nodeIds.has(id) ? coveredNodes.add(id) : stale.add(id)));
        }
      }
      if (value.kind === 'route' && typeof nodeId === 'string' && typeof value.expectedRoute === 'string') {
        const key = `${nodeId}:${value.expectedRoute}`;
        if (routeKeys.has(key)) coveredRoutes.add(key);
        else stale.add(`${nodeId}:${value.expectedRoute}`);
      }
    }
  }
  return { coveredNodes, coveredRoutes, missingNodes: nodes.filter((node) => !coveredNodes.has(node.id)), missingRoutes: routes.filter((route) => !coveredRoutes.has(`${route.nodeId}:${route.route}`)), stale: [...stale] };
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
  totalCases: number;
  passedCases: number;
  failedCases: number;
}): RunOutcome {
  if (run.status === 'queued') return 'queued';
  if (run.status === 'running') return 'running';
  if (run.failedCases > 0 || run.passedCases < run.totalCases) return 'failed';
  return 'passed';
}

function jsonObject(value: string, label: string, t: TFunction) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(t('evaluations.jsonObjectRequired', { label }));
  }
  return parsed;
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function testImportPreview(value: unknown, t: TFunction): TestImportPreview {
  const source = objectValue(value);
  const rawCases = source?.eval_cases;
  if (!Array.isArray(rawCases)) {
    return {
      suiteName: t('evaluations.importedSuite'),
      suiteDescription: '',
      cases: [],
      errors: [t('evaluations.importErrors.missingCases')],
    };
  }
  return {
    suiteName:
      typeof source?.name === 'string' && source.name.trim()
        ? source.name.trim()
        : t('evaluations.importedSuite'),
    suiteDescription:
      typeof source?.description === 'string' ? source.description : '',
    cases: rawCases.map((rawCase, index) => {
      const item = objectValue(rawCase);
      const extension = objectValue(item?.workrun);
      const turn = Array.isArray(item?.conversation)
        ? objectValue(item.conversation[0])
        : undefined;
      const response = objectValue(turn?.final_response);
      const text = Array.isArray(response?.parts)
        ? objectValue(response.parts.find((part) => objectValue(part)?.text))
            ?.text
        : undefined;
      const tools = objectValue(turn?.intermediate_data)?.tool_uses;
      const sessionInput = objectValue(item?.session_input);
      const hasSessionState = sessionInput?.state !== undefined;
      const workrunExpectation = extension?.expectation;
      const workrunFixture = extension?.fixture;
      const workrunAssertions = objectValue(workrunExpectation)?.assertions;
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
      const name =
        typeof extension?.name === 'string' && extension.name.trim()
          ? extension.name.trim()
          : typeof item?.eval_id === 'string' && item.eval_id.trim()
            ? item.eval_id.trim()
            : t('evaluations.importedCase', { index: index + 1 });
      const input = objectValue(sessionInput?.state) ?? {};
      const errors = [
        ...(!item ? [t('evaluations.importErrors.caseObject')] : []),
        ...(hasSessionState && !objectValue(sessionInput?.state)
          ? [t('evaluations.importErrors.sessionStateObject')]
          : []),
        ...(workrunExpectation !== undefined &&
        (!objectValue(workrunExpectation) ||
          !Array.isArray(workrunAssertions) ||
          !workrunAssertions.length)
          ? [t('evaluations.importErrors.assertionsArray')]
          : []),
        ...(workrunFixture !== undefined && !objectValue(workrunFixture)
          ? [t('evaluations.importErrors.fixtureObject')]
          : []),
        ...(!extension?.expectation && !adkAssertions.length
          ? [t('evaluations.importErrors.missingAssertion')]
          : []),
      ];
      return {
        index,
        name,
        description:
          typeof item?.description === 'string' ? item.description : '',
        enabled: extension?.enabled !== false,
        input,
        expectation: workrunExpectation ?? { assertions: adkAssertions },
        fixture: workrunFixture ?? { toolFixtures: [] },
        errors,
      };
    }),
    errors: rawCases.length ? [] : [t('evaluations.importErrors.emptyCases')],
  };
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

function nodeTrajectoryDraft(value: unknown): NodeTrajectoryDraft {
  const assertions = (value as { assertions?: unknown } | undefined)
    ?.assertions;
  const trajectory = Array.isArray(assertions)
    ? assertions.find(
        (assertion) =>
          assertion &&
          typeof assertion === 'object' &&
          (assertion as Record<string, unknown>).kind === 'node_trajectory',
      )
    : undefined;
  const record = trajectory as Record<string, unknown> | undefined;
  const nodeIds = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((node): node is string => typeof node === 'string')
      : [];
  return {
    mustExecute: nodeIds(record?.mustExecute ?? record?.must_execute),
    mustNotExecute: nodeIds(record?.mustNotExecute ?? record?.must_not_execute),
    orderedNodes: nodeIds(record?.orderedNodes ?? record?.ordered_nodes),
    requireCompleted:
      (record?.requireCompleted ?? record?.require_completed) !== false,
  };
}

function routeAssertionDrafts(value: unknown): RouteAssertionDraft[] {
  const assertions = (value as { assertions?: unknown } | undefined)
    ?.assertions;
  return Array.isArray(assertions)
    ? assertions.flatMap((assertion) => {
        if (!assertion || typeof assertion !== 'object') return [];
        const item = assertion as Record<string, unknown>;
        return item.kind === 'route' &&
          typeof item.nodeId === 'string' &&
          typeof item.expectedRoute === 'string'
          ? [
              {
                id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
                nodeId: item.nodeId,
                expectedRoute: item.expectedRoute,
              },
            ]
          : [];
      })
    : [];
}

function nodeOutputAssertionDrafts(value: unknown): NodeOutputAssertionDraft[] {
  const assertions = (value as { assertions?: unknown } | undefined)?.assertions;
  return Array.isArray(assertions)
    ? assertions.flatMap((assertion) => {
        if (!assertion || typeof assertion !== 'object') return [];
        const item = assertion as Record<string, unknown>;
        return item.kind === 'node_output' &&
          typeof item.nodeId === 'string' &&
          typeof item.path === 'string' &&
          typeof item.operator === 'string'
          ? [{
              id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
              nodeId: item.nodeId,
              path: item.path,
              operator: item.operator as NodeOutputAssertionDraft['operator'],
              expected:
                typeof item.expected === 'string'
                  ? item.expected
                  : JSON.stringify(item.expected) ?? '',
            }]
          : [];
      })
    : [];
}

function nodeTextAssertionDrafts(value: unknown): NodeTextAssertionDraft[] {
  const assertions = (value as { assertions?: unknown } | undefined)?.assertions;
  return Array.isArray(assertions) ? assertions.flatMap((assertion) => {
    if (!assertion || typeof assertion !== 'object') return [];
    const item = assertion as Record<string, unknown>;
    return item.kind === 'node_text' && typeof item.nodeId === 'string' && typeof item.expected === 'string'
      ? [{ id: typeof item.id === 'string' ? item.id : crypto.randomUUID(), nodeId: item.nodeId, algorithm: item.algorithm as MatchAlgorithm, expected: item.expected }]
      : [];
  }) : [];
}

function nodeToolAssertionDrafts(value: unknown): NodeToolAssertionDraft[] {
  const assertions = (value as { assertions?: unknown } | undefined)?.assertions;
  return Array.isArray(assertions) ? assertions.flatMap((assertion) => {
    if (!assertion || typeof assertion !== 'object') return [];
    const item = assertion as Record<string, unknown>;
    const tool = Array.isArray(item.tools) ? item.tools[0] as Record<string, unknown> | undefined : undefined;
    return item.kind === 'node_tool_trajectory' && typeof item.nodeId === 'string' && typeof tool?.name === 'string'
      ? [{ id: typeof item.id === 'string' ? item.id : crypto.randomUUID(), nodeId: item.nodeId, toolName: tool.name, count: Math.max(1, item.tools.length) }]
      : [];
  }) : [];
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
            nodeId: typeof item.nodeId === 'string' ? item.nodeId : '',
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

function trajectoryAssertion(draft: ToolTrajectoryDraft, t: TFunction) {
  const tools = draft.calls.flatMap((call) => {
    if (!call.name.trim()) throw new Error(t('evaluations.toolNameRequired'));
    const tool = {
      name: call.name.trim(),
      args: jsonObject(call.args, t('evaluations.toolArguments'), t),
      ...(call.assertResult
        ? {
            expectedResponse: jsonObject(
              call.expectedResult,
              t('evaluations.expectedFixtureResult'),
              t,
            ),
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

function nodeTrajectoryAssertion(draft: NodeTrajectoryDraft) {
  return draft.mustExecute.length ||
    draft.mustNotExecute.length ||
    draft.orderedNodes.length
    ? {
        kind: 'node_trajectory',
        id: crypto.randomUUID(),
        mustExecute: draft.mustExecute,
        mustNotExecute: draft.mustNotExecute,
        orderedNodes: draft.orderedNodes,
        requireCompleted: draft.requireCompleted,
      }
    : undefined;
}

function routeAssertions(drafts: RouteAssertionDraft[]) {
  return drafts.map((draft) => ({
    kind: 'route',
    id: draft.id,
    nodeId: draft.nodeId,
    expectedRoute: draft.expectedRoute,
  }));
}

function nodeOutputAssertions(drafts: NodeOutputAssertionDraft[]) {
  return drafts.map((draft) => ({
    kind: 'node_output',
    id: draft.id,
    nodeId: draft.nodeId,
    path: draft.path,
    operator: draft.operator,
    expected: draft.expected,
  }));
}

function nodeTextAssertions(drafts: NodeTextAssertionDraft[]) {
  return drafts.map((draft) => ({ kind: 'node_text', id: draft.id, nodeId: draft.nodeId, algorithm: draft.algorithm, expected: draft.expected, threshold: draft.algorithm === 'levenshtein' ? 0.8 : 1 }));
}

function nodeToolAssertions(drafts: NodeToolAssertionDraft[]) {
  return drafts.map((draft) => ({ kind: 'node_tool_trajectory', id: draft.id, nodeId: draft.nodeId, tools: Array.from({ length: draft.count }, () => ({ name: draft.toolName, args: {} })), config: { strictOrder: true, strictArgs: false } }));
}

function fixturesFromDrafts(drafts: ToolFixtureDraft[], t: TFunction) {
  return {
    toolFixtures: drafts.map((fixture) => {
      if (!fixture.tool.trim())
        throw new Error(t('evaluations.fixtureToolRequired'));
      return {
        ...(fixture.nodeId ? { nodeId: fixture.nodeId } : {}),
        tool: fixture.tool.trim(),
        args: jsonObject(fixture.args, t('evaluations.fixtureArgs'), t),
        result: jsonObject(fixture.result, t('evaluations.fixtureResult'), t),
      };
    }),
  };
}

function expectationFromVisualAssertions(
  value: unknown,
  assertions: VisualAssertion[],
  trajectory: ToolTrajectoryDraft,
  nodeTrajectory: NodeTrajectoryDraft,
  routes: RouteAssertionDraft[],
  nodeOutputs: NodeOutputAssertionDraft[],
  nodeTexts: NodeTextAssertionDraft[],
  nodeTools: NodeToolAssertionDraft[],
  safety: SafetyAssertionDraft[],
  t: TFunction,
) {
  const source = value && typeof value === 'object' ? value : {};
  const { assertions: existing, ...base } = source as Record<string, unknown>;
  const preserved = Array.isArray(existing)
    ? existing.filter(
        (assertion) =>
          !(
            typeof assertion === 'object' &&
            assertion !== null &&
            [
              'json_path',
              'text',
              'tool_trajectory',
              'node_trajectory',
              'route',
              'node_output',
              'node_text',
              'node_tool_trajectory',
              'safety',
            ].includes(String((assertion as Record<string, unknown>).kind))
          ),
      )
    : [];
  const toolAssertion = trajectoryAssertion(trajectory, t);
  const nodeAssertion = nodeTrajectoryAssertion(nodeTrajectory);
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
      ...(nodeAssertion ? [nodeAssertion] : []),
      ...routeAssertions(routes),
      ...nodeOutputAssertions(nodeOutputs),
      ...nodeTextAssertions(nodeTexts),
      ...nodeToolAssertions(nodeTools),
      ...safetyAssertions(safety),
    ],
  };
}

function serializeVisualAssertions(
  assertions: VisualAssertion[],
  trajectory: ToolTrajectoryDraft,
  nodeTrajectory: NodeTrajectoryDraft,
  routes: RouteAssertionDraft[],
  nodeOutputs: NodeOutputAssertionDraft[],
  nodeTexts: NodeTextAssertionDraft[],
  nodeTools: NodeToolAssertionDraft[],
  safety: SafetyAssertionDraft[],
  t: TFunction,
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
    toolAssertion = trajectoryAssertion(trajectory, t);
  } catch {
    toolAssertion = undefined;
  }
  const nodeAssertion = nodeTrajectoryAssertion(nodeTrajectory);
  return [
    ...output,
    ...(toolAssertion ? [toolAssertion] : []),
    ...(nodeAssertion ? [nodeAssertion] : []),
    ...routeAssertions(routes),
    ...nodeOutputAssertions(nodeOutputs),
    ...nodeTextAssertions(nodeTexts),
    ...nodeToolAssertions(nodeTools),
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
  const [nodeTextDrafts, setNodeTextDrafts] = useState<NodeTextAssertionDraft[]>([]);
  const [nodeToolDrafts, setNodeToolDrafts] = useState<NodeToolAssertionDraft[]>([]);
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
                  <div><p className='text-muted-foreground text-xs'>{t('evaluations.nodeCoverage')}</p><p className='mt-1 text-lg font-semibold'>{coverage.coveredNodes.size}/{configuredWorkflowNodes.length}</p></div>
                  <div><p className='text-muted-foreground text-xs'>{t('evaluations.routeCoverage')}</p><p className='mt-1 text-lg font-semibold'>{coverage.coveredRoutes.size}/{configuredRoutes.length}</p></div>
                  <div><p className='text-muted-foreground text-xs'>{t('evaluations.staleAssertions')}</p><p className='mt-1 text-lg font-semibold'>{coverage.stale.length}</p></div>
                  {coverage.missingNodes.length || coverage.missingRoutes.length || coverage.stale.length ? <div className='text-muted-foreground border-t pt-3 text-xs sm:col-span-3'>
                    {coverage.missingNodes.length ? <p>{t('evaluations.uncoveredNodes')}: {coverage.missingNodes.map((node) => node.label).join('、')}</p> : null}
                    {coverage.missingRoutes.length ? <p>{t('evaluations.uncoveredRoutes')}: {coverage.missingRoutes.map((route) => `${route.nodeLabel} → ${route.label}`).join('、')}</p> : null}
                    {coverage.stale.length ? <p className='text-destructive'>{t('evaluations.staleAssertionTargets')}: {coverage.stale.join('、')}</p> : null}
                  </div> : <p className='text-muted-foreground border-t pt-3 text-xs sm:col-span-3'>{t('evaluations.coverageComplete')}</p>}
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

      <Dialog
        open={Boolean(selectedVersionDiff)}
        onOpenChange={(open) => {
          if (!open) setSelectedVersionDiff(undefined);
        }}
      >
        <DialogContent className='max-w-2xl! gap-0 overflow-hidden p-0'>
          <DialogHeader className='border-b bg-linear-to-br from-rose-500/10 to-amber-500/10 px-6 py-5 pr-14'>
            <DialogTitle className='text-lg'>
              {t('evaluations.regressionLocation')}
            </DialogTitle>
            <DialogDescription className='mt-1'>
              {selectedVersionDiff?.name}
            </DialogDescription>
          </DialogHeader>
          <div className='max-h-[min(62vh,560px)] overflow-y-auto px-6 py-5'>
            {versionCriteriaDiff.isLoading ? (
              <div className='text-muted-foreground flex items-center gap-2 py-8 text-sm'>
                <Spinner className='size-4' />
                {t('evaluations.loadingRegressionLocation')}
              </div>
            ) : versionCriteriaDiff.data ? (
              <VersionCriterionComparison
                comparison={versionCriteriaDiff.data}
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
              />
            ) : (
              <p className='text-muted-foreground py-8 text-sm'>
                {t('evaluations.noCriterionDifferences')}
              </p>
            )}
          </div>
          <DialogFooter className='mx-0 mb-0'>
            <Button variant='outline' onClick={() => setSelectedVersionDiff(undefined)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={qualityGateOpen} onOpenChange={setQualityGateOpen}>
        <DialogContent className='max-w-2xl! gap-0 overflow-hidden p-0'>
          <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-amber-500/12 to-violet-500/10 px-6 py-6 pr-14'>
            <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(38_92%_50%/0.14)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
            <div className='relative flex items-start gap-3'>
              <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 text-amber-700 shadow-sm dark:text-amber-300'>
                <ShieldCheckIcon className='size-5' />
              </div>
              <div>
                <DialogTitle className='text-lg'>
                  {t('evaluations.qualityGate')}
                </DialogTitle>
                <DialogDescription className='mt-1 max-w-xl leading-5'>
                  {t('evaluations.gateDescription')}
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
                  {t('evaluations.requireEvaluation')}
                </FieldLabel>
              </Field>
              <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
                <FieldLegend>{t('evaluations.overallThresholds')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.thresholdDescription')}
                </FieldDescription>
                <div className='mt-4 grid gap-4 sm:grid-cols-3'>
                  <Field>
                    <FieldLabel>{t('evaluations.minimumPassRate')}</FieldLabel>
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
                    <FieldLabel>{t('evaluations.maximumCost')}</FieldLabel>
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
                    <FieldLabel>{t('evaluations.maximumDuration')}</FieldLabel>
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
                <FieldLegend>{t('evaluations.requiredSuites')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.requiredSuitesDescription')}
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
          <DialogFooter className='mx-0 mb-0'>
            <Button variant='outline' onClick={() => setQualityGateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void saveQualityGate()}>
              {t('evaluations.saveQualityGate')}
            </Button>
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
                  {editingSuite
                    ? t('evaluations.editSuite')
                    : t('evaluations.newSuite')}
                </DialogTitle>
                <DialogDescription className='mt-1 max-w-md leading-5'>
                  {t('evaluations.suiteDescription')}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='px-6 py-6'>
            <FieldSet className='bg-muted/20 rounded-xl border p-4 sm:p-5'>
              <FieldLegend>{t('evaluations.suiteDetails')}</FieldLegend>
              <FieldDescription>
                {t('evaluations.suiteDetailsDescription')}
              </FieldDescription>
              <FieldGroup className='mt-5 gap-5'>
                <Field>
                  <FieldLabel htmlFor='evaluation-suite-name'>
                    {t('common.name')}
                  </FieldLabel>
                  <Input
                    id='evaluation-suite-name'
                    value={suiteName}
                    placeholder={t('evaluations.suiteNamePlaceholder')}
                    onChange={(event) => setSuiteName(event.target.value)}
                    autoFocus
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor='evaluation-suite-description'>
                    {t('common.description')}{' '}
                    <span className='text-muted-foreground font-normal'>
                      {t('common.optional')}
                    </span>
                  </FieldLabel>
                  <Textarea
                    id='evaluation-suite-description'
                    className='min-h-24 resize-y'
                    placeholder={t('evaluations.suiteDescriptionPlaceholder')}
                    value={suiteDescription}
                    onChange={(event) =>
                      setSuiteDescription(event.target.value)
                    }
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
          </div>
          <DialogFooter className='mx-0 mb-0'>
            <Button
              variant='outline'
              disabled={saving}
              onClick={() => setSuiteDialogOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!suiteName.trim() || saving}
              onClick={() => void saveSuite()}
            >
              {saving ? <Spinner /> : null}{' '}
              {editingSuite
                ? t('evaluations.saveSuite')
                : t('evaluations.createSuite')}
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
            <AlertDialogHeading>
              {t('evaluations.deleteSuiteTitle')}
            </AlertDialogHeading>
            <AlertDialogBody>
              {t('evaluations.deleteSuiteDescription', {
                name: deleteSuite?.name,
              })}
            </AlertDialogBody>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={saving}
              onClick={() => void removeSuite()}
            >
              {saving ? <Spinner /> : null} {t('evaluations.deleteSuite')}
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
            <AlertDialogHeading>
              {t('evaluations.deleteCaseTitle')}
            </AlertDialogHeading>
            <AlertDialogBody>
              {t('evaluations.deleteCaseDescription', {
                name: deleteCase?.name,
              })}
            </AlertDialogBody>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDeleteCase()}>
              {t('evaluations.deleteCase')}
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
                  {editingCase
                    ? t('evaluations.editCase')
                    : t('evaluations.addCase')}
                </DialogTitle>
                <DialogDescription className='mt-1 max-w-xl leading-5'>
                  {t('evaluations.caseDescription')}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
            <FieldGroup className='gap-7'>
              <FieldSet>
                <FieldLegend>{t('evaluations.caseDetails')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.caseDetailsDescription')}
                </FieldDescription>
                <FieldGroup className='gap-5'>
                  <Field>
                    <FieldLabel htmlFor='evaluation-case-name'>
                      {t('common.name')}
                    </FieldLabel>
                    <Input
                      id='evaluation-case-name'
                      value={caseName}
                      onChange={(event) => setCaseName(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor='evaluation-case-description'>
                      {t('common.description')}
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
                <FieldLegend>{t('evaluations.workflowInput')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.workflowInputDescription')}
                </FieldDescription>
                <FieldGroup className='gap-5'>
                  <Field>
                    <FieldLabel htmlFor='evaluation-case-input'>
                      {t('evaluations.inputJson')}
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
                    <FieldLegend>{t('evaluations.assertionRules')}</FieldLegend>
                    <FieldDescription>
                      {t('evaluations.assertionRulesDescription')}
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
                    <PlusIcon data-icon='inline-start' />{' '}
                    {t('evaluations.addRule')}
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
                          {t('evaluations.rule', { index: index + 1 })}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={t('evaluations.deleteRule', {
                            index: index + 1,
                          })}
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
                          <FieldLabel>
                            {t('evaluations.assertionTarget')}
                          </FieldLabel>
                          <Select
                            value={assertion.subject}
                            items={[
                              {
                                value: 'final_json',
                                label: t('evaluations.finalOutputField'),
                              },
                              {
                                value: 'final_text',
                                label: t('evaluations.finalOutputText'),
                              },
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
                                  {t('evaluations.finalOutputField')}
                                </SelectItem>
                                <SelectItem value='final_text'>
                                  {t('evaluations.finalOutputText')}
                                </SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        {assertion.subject === 'final_json' ? (
                          <Field>
                            <FieldLabel>
                              {t('evaluations.fieldPath')}
                            </FieldLabel>
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
                          <FieldLabel>{t('evaluations.operator')}</FieldLabel>
                          <Select
                            value={assertion.operator}
                            items={
                              assertion.subject === 'final_json'
                                ? [
                                    {
                                      value: 'equals',
                                      label: t('evaluations.equals'),
                                    },
                                    {
                                      value: 'not_equals',
                                      label: t('evaluations.notEquals'),
                                    },
                                    {
                                      value: 'contains',
                                      label: t('evaluations.contains'),
                                    },
                                    {
                                      value: 'not_contains',
                                      label: t('evaluations.notContains'),
                                    },
                                    {
                                      value: 'exists',
                                      label: t('evaluations.fieldExists'),
                                    },
                                  ]
                                : [
                                    {
                                      value: 'exact',
                                      label: t('evaluations.exactMatch'),
                                    },
                                    {
                                      value: 'contains',
                                      label: t('evaluations.containsText'),
                                    },
                                    {
                                      value: 'levenshtein',
                                      label: t('evaluations.textSimilarity'),
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
                                    <SelectItem value='equals'>
                                      {t('evaluations.equals')}
                                    </SelectItem>
                                    <SelectItem value='not_equals'>
                                      {t('evaluations.notEquals')}
                                    </SelectItem>
                                    <SelectItem value='contains'>
                                      {t('evaluations.contains')}
                                    </SelectItem>
                                    <SelectItem value='not_contains'>
                                      {t('evaluations.notContains')}
                                    </SelectItem>
                                    <SelectItem value='exists'>
                                      {t('evaluations.fieldExists')}
                                    </SelectItem>
                                  </>
                                ) : (
                                  <>
                                    <SelectItem value='exact'>
                                      {t('evaluations.exactMatch')}
                                    </SelectItem>
                                    <SelectItem value='contains'>
                                      {t('evaluations.containsText')}
                                    </SelectItem>
                                    <SelectItem value='levenshtein'>
                                      {t('evaluations.textSimilarity')}
                                    </SelectItem>
                                  </>
                                )}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        {assertion.operator !== 'exists' ? (
                          <Field>
                            <FieldLabel>
                              {t('evaluations.expectedValue')}
                            </FieldLabel>
                            <Input
                              value={assertion.expected}
                              placeholder={
                                assertion.subject === 'final_json'
                                  ? t('evaluations.expectedJsonValue')
                                  : t('evaluations.expectedText')
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
                      {t('evaluations.noAssertionRules')}
                    </p>
                  ) : null}
                </FieldGroup>
              </FieldSet>

              <FieldSet className='rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'>
                  <div><FieldLegend>{t('evaluations.agentMessageAssertions')}</FieldLegend><FieldDescription>{t('evaluations.agentMessageAssertionsDescription')}</FieldDescription></div>
                  <Button type='button' variant='outline' size='sm' disabled={!configuredAgentNodes.length} onClick={() => { const node = configuredAgentNodes[0]; if (node) setNodeTextDrafts((current) => [...current, { id: crypto.randomUUID(), nodeId: node.id, algorithm: 'contains', expected: '' }]); }}><PlusIcon data-icon='inline-start' /> {t('evaluations.addAgentMessageAssertion')}</Button>
                </div>
                {configuredAgentNodes.length ? <FieldGroup className='mt-4 gap-3'>
                  {nodeTextDrafts.map((draft, index) => <div key={draft.id} className='grid gap-3 rounded-lg border bg-background p-3 sm:grid-cols-3'>
                    <Field><FieldLabel>{t('evaluations.agentNode')}</FieldLabel><Select value={draft.nodeId} items={configuredAgentNodes.map((node) => ({ value: node.id, label: node.label }))} onValueChange={(nodeId) => setNodeTextDrafts((current) => current.map((item) => item.id === draft.id && nodeId ? { ...item, nodeId } : item))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{configuredAgentNodes.map((node) => <SelectItem key={node.id} value={node.id}>{node.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
                    <Field><FieldLabel>{t('evaluations.operator')}</FieldLabel><Select value={draft.algorithm} items={[{ value: 'exact', label: t('evaluations.exactMatch') }, { value: 'contains', label: t('evaluations.containsText') }, { value: 'levenshtein', label: t('evaluations.textSimilarity') }]} onValueChange={(algorithm) => setNodeTextDrafts((current) => current.map((item) => item.id === draft.id && algorithm ? { ...item, algorithm: algorithm as MatchAlgorithm } : item))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value='exact'>{t('evaluations.exactMatch')}</SelectItem><SelectItem value='contains'>{t('evaluations.containsText')}</SelectItem><SelectItem value='levenshtein'>{t('evaluations.textSimilarity')}</SelectItem></SelectGroup></SelectContent></Select></Field>
                    <Field><FieldLabel>{t('evaluations.expectedText')}</FieldLabel><div className='flex gap-2'><Input value={draft.expected} onChange={(event) => setNodeTextDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, expected: event.target.value } : item))} /><Button type='button' variant='ghost' size='icon-sm' aria-label={t('evaluations.deleteAgentMessageAssertion', { index: index + 1 })} onClick={() => setNodeTextDrafts((current) => current.filter((item) => item.id !== draft.id))}><Trash2Icon /></Button></div></Field>
                  </div>)}
                  {!nodeTextDrafts.length ? <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>{t('evaluations.noAgentMessageAssertions')}</p> : null}
                </FieldGroup> : <p className='text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-sm'>{t('evaluations.noAgentNodes')}</p>}
              </FieldSet>

              <FieldSet className='rounded-xl border border-teal-500/20 bg-teal-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'><div><FieldLegend>{t('evaluations.nodeToolAssertions')}</FieldLegend><FieldDescription>{t('evaluations.nodeToolAssertionsDescription')}</FieldDescription></div><Button type='button' variant='outline' size='sm' disabled={!configuredAgentNodes.length || !configuredTools.length} onClick={() => { const node = configuredAgentNodes[0]; const tool = configuredTools[0]; if (node && tool) setNodeToolDrafts((current) => [...current, { id: crypto.randomUUID(), nodeId: node.id, toolName: tool.name, count: 1 }]); }}><PlusIcon data-icon='inline-start' /> {t('evaluations.addNodeToolAssertion')}</Button></div>
                <FieldGroup className='mt-4 gap-3'>{nodeToolDrafts.map((draft, index) => <div key={draft.id} className='grid gap-3 rounded-lg border bg-background p-3 sm:grid-cols-4'><Field><FieldLabel>{t('evaluations.agentNode')}</FieldLabel><Select value={draft.nodeId} items={configuredAgentNodes.map((node) => ({ value: node.id, label: node.label }))} onValueChange={(nodeId) => setNodeToolDrafts((current) => current.map((item) => item.id === draft.id && nodeId ? { ...item, nodeId } : item))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{configuredAgentNodes.map((node) => <SelectItem key={node.id} value={node.id}>{node.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>{t('evaluations.tool')}</FieldLabel><Select value={draft.toolName} items={configuredTools.map((tool) => ({ value: tool.name, label: toolLabel(tool) }))} onValueChange={(toolName) => setNodeToolDrafts((current) => current.map((item) => item.id === draft.id && toolName ? { ...item, toolName } : item))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{configuredTools.map((tool) => <SelectItem key={tool.id} value={tool.name}>{toolLabel(tool)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Field><FieldLabel>{t('evaluations.callCount')}</FieldLabel><Input type='number' min={1} value={draft.count} onChange={(event) => setNodeToolDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, count: Math.max(1, Number(event.target.value) || 1) } : item))} /></Field><Button type='button' variant='ghost' size='icon-sm' className='self-end' aria-label={t('evaluations.deleteNodeToolAssertion', { index: index + 1 })} onClick={() => setNodeToolDrafts((current) => current.filter((item) => item.id !== draft.id))}><Trash2Icon /></Button></div>)}{!nodeToolDrafts.length ? <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>{t('evaluations.noNodeToolAssertions')}</p> : null}</FieldGroup>
              </FieldSet>

              <FieldSet className='rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'>
                  <div>
                    <FieldLegend>{t('evaluations.nodeOutputAssertions')}</FieldLegend>
                    <FieldDescription>{t('evaluations.nodeOutputAssertionsDescription')}</FieldDescription>
                  </div>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={!configuredWorkflowNodes.length}
                    onClick={() => {
                      const node = configuredWorkflowNodes[0];
                      if (!node) return;
                      setNodeOutputDrafts((current) => [
                        ...current,
                        { id: crypto.randomUUID(), nodeId: node.id, path: '$.', operator: 'equals', expected: '' },
                      ]);
                    }}
                  >
                    <PlusIcon data-icon='inline-start' /> {t('evaluations.addNodeOutputAssertion')}
                  </Button>
                </div>
                {configuredWorkflowNodes.length ? (
                  <FieldGroup className='mt-4 gap-3'>
                    {nodeOutputDrafts.map((draft, index) => (
                      <div key={draft.id} className='grid gap-3 rounded-lg border bg-background p-3 sm:grid-cols-2'>
                        <Field>
                          <FieldLabel>{t('evaluations.outputNode')}</FieldLabel>
                          <Select value={draft.nodeId} items={configuredWorkflowNodes.map((node) => ({ value: node.id, label: node.label }))} onValueChange={(nodeId) => setNodeOutputDrafts((current) => current.map((item) => item.id === draft.id && nodeId ? { ...item, nodeId } : item))}>
                            <SelectTrigger><SelectValue placeholder={t('evaluations.selectWorkflowNode')} /></SelectTrigger>
                            <SelectContent><SelectGroup>{configuredWorkflowNodes.map((node) => <SelectItem key={node.id} value={node.id}>{node.label}</SelectItem>)}</SelectGroup></SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>{t('evaluations.fieldPath')}</FieldLabel>
                          <Input value={draft.path} placeholder='$.riskLevel' onChange={(event) => setNodeOutputDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, path: event.target.value } : item))} />
                        </Field>
                        <Field>
                          <FieldLabel>{t('evaluations.operator')}</FieldLabel>
                          <Select
                            value={draft.operator}
                            items={[
                              { value: 'equals', label: t('evaluations.equals') },
                              { value: 'not_equals', label: t('evaluations.notEquals') },
                              { value: 'contains', label: t('evaluations.contains') },
                              { value: 'not_contains', label: t('evaluations.notContains') },
                              { value: 'exists', label: t('evaluations.fieldExists') },
                            ]}
                            onValueChange={(operator) => setNodeOutputDrafts((current) => current.map((item) => item.id === draft.id && operator ? { ...item, operator: operator as NodeOutputAssertionDraft['operator'] } : item))}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent><SelectGroup>
                              <SelectItem value='equals'>{t('evaluations.equals')}</SelectItem><SelectItem value='not_equals'>{t('evaluations.notEquals')}</SelectItem><SelectItem value='contains'>{t('evaluations.contains')}</SelectItem><SelectItem value='not_contains'>{t('evaluations.notContains')}</SelectItem><SelectItem value='exists'>{t('evaluations.fieldExists')}</SelectItem>
                            </SelectGroup></SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>{t('evaluations.expectedValue')}</FieldLabel>
                          <div className='flex gap-2'><Input value={draft.expected} disabled={draft.operator === 'exists'} onChange={(event) => setNodeOutputDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, expected: event.target.value } : item))} /><Button type='button' variant='ghost' size='icon-sm' aria-label={t('evaluations.deleteNodeOutputAssertion', { index: index + 1 })} onClick={() => setNodeOutputDrafts((current) => current.filter((item) => item.id !== draft.id))}><Trash2Icon /></Button></div>
                        </Field>
                      </div>
                    ))}
                    {!nodeOutputDrafts.length ? <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>{t('evaluations.noNodeOutputAssertions')}</p> : null}
                  </FieldGroup>
                ) : <p className='text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-sm'>{t('evaluations.noWorkflowNodes')}</p>}
              </FieldSet>

              <FieldSet className='rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'>
                  <div>
                    <FieldLegend>
                      {t('evaluations.routeAssertions')}
                    </FieldLegend>
                    <FieldDescription>
                      {t('evaluations.routeAssertionsDescription')}
                    </FieldDescription>
                  </div>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={!configuredRoutes.length}
                    onClick={() => {
                      const route = configuredRoutes[0];
                      if (!route) return;
                      setRouteDrafts((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          nodeId: route.nodeId,
                          expectedRoute: route.route,
                        },
                      ]);
                    }}
                  >
                    <PlusIcon data-icon='inline-start' />{' '}
                    {t('evaluations.addRouteAssertion')}
                  </Button>
                </div>
                {configuredRoutes.length ? (
                  <FieldGroup className='mt-4 gap-3'>
                    {routeDrafts.map((draft, index) => {
                      const routesForNode = configuredRoutes.filter(
                        (route) => route.nodeId === draft.nodeId,
                      );
                      return (
                        <div
                          key={draft.id}
                          className='bg-background grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]'
                        >
                          <Field>
                            <FieldLabel>
                              {t('evaluations.routeNode')}
                            </FieldLabel>
                            <Select
                              value={draft.nodeId}
                              items={configuredRouteNodes.map((route) => ({
                                value: route.nodeId,
                                label: route.nodeLabel,
                              }))}
                              onValueChange={(nodeId) => {
                                const firstRoute = configuredRoutes.find(
                                  (route) => route.nodeId === nodeId,
                                );
                                setRouteDrafts((current) =>
                                  current.map((item) =>
                                    item.id === draft.id && nodeId && firstRoute
                                      ? {
                                          ...item,
                                          nodeId,
                                          expectedRoute: firstRoute.route,
                                        }
                                      : item,
                                  ),
                                );
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={t('evaluations.selectRouteNode')}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {configuredRouteNodes.map((route) => (
                                    <SelectItem
                                      key={route.nodeId}
                                      value={route.nodeId}
                                    >
                                      {route.nodeLabel}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field>
                            <FieldLabel>
                              {t('evaluations.expectedRoute')}
                            </FieldLabel>
                            <Select
                              value={draft.expectedRoute}
                              items={routesForNode.map((route) => ({
                                value: route.route,
                                label: route.label,
                              }))}
                              onValueChange={(expectedRoute) =>
                                setRouteDrafts((current) =>
                                  current.map((item) =>
                                    item.id === draft.id && expectedRoute
                                      ? { ...item, expectedRoute }
                                      : item,
                                  ),
                                )
                              }
                            >
                              <SelectTrigger>
                                <SelectValue
                                  placeholder={t(
                                    'evaluations.selectExpectedRoute',
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {routesForNode.map((route) => (
                                    <SelectItem
                                      key={route.route}
                                      value={route.route}
                                    >
                                      {route.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon-sm'
                            className='self-end'
                            aria-label={t('evaluations.deleteRouteAssertion', {
                              index: index + 1,
                            })}
                            onClick={() =>
                              setRouteDrafts((current) =>
                                current.filter((item) => item.id !== draft.id),
                              )
                            }
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      );
                    })}
                    {!routeDrafts.length ? (
                      <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                        {t('evaluations.noRouteAssertions')}
                      </p>
                    ) : null}
                  </FieldGroup>
                ) : (
                  <p className='text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                    {t('evaluations.noRouteNodes')}
                  </p>
                )}
              </FieldSet>

              <FieldSet className='rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'>
                  <div>
                    <FieldLegend>{t('evaluations.nodeTrajectory')}</FieldLegend>
                    <FieldDescription>
                      {t('evaluations.nodeTrajectoryDescription')}
                    </FieldDescription>
                  </div>
                </div>
                {configuredWorkflowNodes.length ? (
                  <FieldGroup className='mt-4 gap-4'>
                    <div className='grid gap-4 lg:grid-cols-2'>
                      <Field className='bg-background rounded-lg border p-3'>
                        <div className='mb-3 flex items-center justify-between gap-3'>
                          <FieldLabel>
                            {t('evaluations.requiredNodes')}
                          </FieldLabel>
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            onClick={() =>
                              setNodeTrajectory((current) => {
                                const node = configuredWorkflowNodes.find(
                                  (candidate) =>
                                    !current.mustExecute.includes(
                                      candidate.id,
                                    ) &&
                                    !current.mustNotExecute.includes(
                                      candidate.id,
                                    ),
                                );
                                return node
                                  ? {
                                      ...current,
                                      mustExecute: [
                                        ...current.mustExecute,
                                        node.id,
                                      ],
                                    }
                                  : current;
                              })
                            }
                          >
                            <PlusIcon data-icon='inline-start' />{' '}
                            {t('evaluations.addNode')}
                          </Button>
                        </div>
                        <div className='flex flex-col gap-2'>
                          {nodeTrajectory.mustExecute.map((nodeId, index) => (
                            <div
                              key={`${nodeId}-${index}`}
                              className='flex items-center gap-2'
                            >
                              <Select
                                value={nodeId}
                                items={configuredWorkflowNodes.map((node) => ({
                                  value: node.id,
                                  label: node.label,
                                }))}
                                onValueChange={(value) =>
                                  setNodeTrajectory((current) => ({
                                    ...current,
                                    mustExecute: current.mustExecute.map(
                                      (node, itemIndex) =>
                                        itemIndex === index
                                          ? (value ?? '')
                                          : node,
                                    ),
                                  }))
                                }
                              >
                                <SelectTrigger className='min-w-0 flex-1'>
                                  <SelectValue
                                    placeholder={t(
                                      'evaluations.selectWorkflowNode',
                                    )}
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {configuredWorkflowNodes.map((node) => (
                                      <SelectItem key={node.id} value={node.id}>
                                        {node.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                              <Button
                                type='button'
                                variant='ghost'
                                size='icon-sm'
                                aria-label={t('evaluations.removeNode', {
                                  index: index + 1,
                                })}
                                onClick={() =>
                                  setNodeTrajectory((current) => ({
                                    ...current,
                                    mustExecute: current.mustExecute.filter(
                                      (_, itemIndex) => itemIndex !== index,
                                    ),
                                  }))
                                }
                              >
                                <Trash2Icon />
                              </Button>
                            </div>
                          ))}
                          {!nodeTrajectory.mustExecute.length ? (
                            <p className='text-muted-foreground text-sm'>
                              {t('evaluations.noRequiredNodes')}
                            </p>
                          ) : null}
                        </div>
                      </Field>
                      <Field className='bg-background rounded-lg border p-3'>
                        <div className='mb-3 flex items-center justify-between gap-3'>
                          <FieldLabel>
                            {t('evaluations.forbiddenNodes')}
                          </FieldLabel>
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            onClick={() =>
                              setNodeTrajectory((current) => {
                                const node = configuredWorkflowNodes.find(
                                  (candidate) =>
                                    !current.mustExecute.includes(
                                      candidate.id,
                                    ) &&
                                    !current.mustNotExecute.includes(
                                      candidate.id,
                                    ),
                                );
                                return node
                                  ? {
                                      ...current,
                                      mustNotExecute: [
                                        ...current.mustNotExecute,
                                        node.id,
                                      ],
                                    }
                                  : current;
                              })
                            }
                          >
                            <PlusIcon data-icon='inline-start' />{' '}
                            {t('evaluations.addNode')}
                          </Button>
                        </div>
                        <div className='flex flex-col gap-2'>
                          {nodeTrajectory.mustNotExecute.map(
                            (nodeId, index) => (
                              <div
                                key={`${nodeId}-${index}`}
                                className='flex items-center gap-2'
                              >
                                <Select
                                  value={nodeId}
                                  items={configuredWorkflowNodes.map(
                                    (node) => ({
                                      value: node.id,
                                      label: node.label,
                                    }),
                                  )}
                                  onValueChange={(value) =>
                                    setNodeTrajectory((current) => ({
                                      ...current,
                                      mustNotExecute:
                                        current.mustNotExecute.map(
                                          (node, itemIndex) =>
                                            itemIndex === index
                                              ? (value ?? '')
                                              : node,
                                        ),
                                    }))
                                  }
                                >
                                  <SelectTrigger className='min-w-0 flex-1'>
                                    <SelectValue
                                      placeholder={t(
                                        'evaluations.selectWorkflowNode',
                                      )}
                                    />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      {configuredWorkflowNodes.map((node) => (
                                        <SelectItem
                                          key={node.id}
                                          value={node.id}
                                        >
                                          {node.label}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                                <Button
                                  type='button'
                                  variant='ghost'
                                  size='icon-sm'
                                  aria-label={t('evaluations.removeNode', {
                                    index: index + 1,
                                  })}
                                  onClick={() =>
                                    setNodeTrajectory((current) => ({
                                      ...current,
                                      mustNotExecute:
                                        current.mustNotExecute.filter(
                                          (_, itemIndex) => itemIndex !== index,
                                        ),
                                    }))
                                  }
                                >
                                  <Trash2Icon />
                                </Button>
                              </div>
                            ),
                          )}
                          {!nodeTrajectory.mustNotExecute.length ? (
                            <p className='text-muted-foreground text-sm'>
                              {t('evaluations.noForbiddenNodes')}
                            </p>
                          ) : null}
                        </div>
                      </Field>
                    </div>
                    <Field className='bg-background rounded-lg border p-3'>
                      <div className='mb-3 flex items-center justify-between gap-3'>
                        <div>
                          <FieldLabel>{t('evaluations.nodeOrder')}</FieldLabel>
                          <FieldDescription>
                            {t('evaluations.nodeOrderDescription')}
                          </FieldDescription>
                        </div>
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          onClick={() =>
                            setNodeTrajectory((current) => ({
                              ...current,
                              orderedNodes: [
                                ...current.orderedNodes,
                                configuredWorkflowNodes[0].id,
                              ],
                            }))
                          }
                        >
                          <PlusIcon data-icon='inline-start' />{' '}
                          {t('evaluations.addNode')}
                        </Button>
                      </div>
                      <div className='flex flex-col gap-2'>
                        {nodeTrajectory.orderedNodes.map((nodeId, index) => (
                          <div
                            key={`${nodeId}-${index}`}
                            className='flex items-center gap-2'
                          >
                            <span className='text-muted-foreground w-5 text-right text-sm'>
                              {index + 1}.
                            </span>
                            <Select
                              value={nodeId}
                              items={configuredWorkflowNodes.map((node) => ({
                                value: node.id,
                                label: node.label,
                              }))}
                              onValueChange={(value) =>
                                setNodeTrajectory((current) => ({
                                  ...current,
                                  orderedNodes: current.orderedNodes.map(
                                    (node, itemIndex) =>
                                      itemIndex === index
                                        ? (value ?? '')
                                        : node,
                                  ),
                                }))
                              }
                            >
                              <SelectTrigger className='min-w-0 flex-1'>
                                <SelectValue
                                  placeholder={t(
                                    'evaluations.selectWorkflowNode',
                                  )}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {configuredWorkflowNodes.map((node) => (
                                    <SelectItem key={node.id} value={node.id}>
                                      {node.label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon-sm'
                              disabled={index === 0}
                              aria-label={t('evaluations.moveNodeUp', {
                                index: index + 1,
                              })}
                              onClick={() =>
                                setNodeTrajectory((current) => {
                                  const orderedNodes = [
                                    ...current.orderedNodes,
                                  ];
                                  [
                                    orderedNodes[index - 1],
                                    orderedNodes[index],
                                  ] = [
                                    orderedNodes[index],
                                    orderedNodes[index - 1],
                                  ];
                                  return { ...current, orderedNodes };
                                })
                              }
                            >
                              <ArrowUpIcon />
                            </Button>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon-sm'
                              disabled={
                                index === nodeTrajectory.orderedNodes.length - 1
                              }
                              aria-label={t('evaluations.moveNodeDown', {
                                index: index + 1,
                              })}
                              onClick={() =>
                                setNodeTrajectory((current) => {
                                  const orderedNodes = [
                                    ...current.orderedNodes,
                                  ];
                                  [
                                    orderedNodes[index],
                                    orderedNodes[index + 1],
                                  ] = [
                                    orderedNodes[index + 1],
                                    orderedNodes[index],
                                  ];
                                  return { ...current, orderedNodes };
                                })
                              }
                            >
                              <ArrowDownIcon />
                            </Button>
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon-sm'
                              aria-label={t('evaluations.removeNode', {
                                index: index + 1,
                              })}
                              onClick={() =>
                                setNodeTrajectory((current) => ({
                                  ...current,
                                  orderedNodes: current.orderedNodes.filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                }))
                              }
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        ))}
                        {!nodeTrajectory.orderedNodes.length ? (
                          <p className='text-muted-foreground text-sm'>
                            {t('evaluations.noNodeOrder')}
                          </p>
                        ) : null}
                      </div>
                    </Field>
                    <Field orientation='horizontal'>
                      <Checkbox
                        id='evaluation-node-require-completed'
                        checked={nodeTrajectory.requireCompleted}
                        onCheckedChange={(checked) =>
                          setNodeTrajectory((current) => ({
                            ...current,
                            requireCompleted: checked === true,
                          }))
                        }
                      />
                      <Label htmlFor='evaluation-node-require-completed'>
                        {t('evaluations.requireNodeCompletion')}
                      </Label>
                    </Field>
                  </FieldGroup>
                ) : (
                  <p className='text-muted-foreground mt-4 rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
                    {t('evaluations.noWorkflowNodes')}
                  </p>
                )}
              </FieldSet>

              <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
                <div className='flex items-start justify-between gap-3'>
                  <div>
                    <FieldLegend>
                      {t('evaluations.safetyAssertions')}
                    </FieldLegend>
                    <FieldDescription>
                      {t('evaluations.safetyAssertionsDescription')}
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
                    <PlusIcon data-icon='inline-start' />{' '}
                    {t('evaluations.addSafetyRule')}
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
                          {t('evaluations.safetyRule', { index: index + 1 })}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={t('evaluations.deleteSafetyRule', {
                            index: index + 1,
                          })}
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
                          <FieldLabel>
                            {t('evaluations.checkTarget')}
                          </FieldLabel>
                          <Select
                            value={rule.target}
                            items={[
                              {
                                value: 'final_output',
                                label: t('evaluations.finalOutput'),
                              },
                              {
                                value: 'tool_arguments',
                                label: t('evaluations.toolArguments'),
                              },
                              {
                                value: 'tool_results',
                                label: t('evaluations.toolResults'),
                              },
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
                                  {t('evaluations.finalOutput')}
                                </SelectItem>
                                <SelectItem value='tool_arguments'>
                                  {t('evaluations.toolArguments')}
                                </SelectItem>
                                <SelectItem value='tool_results'>
                                  {t('evaluations.toolResults')}
                                </SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field>
                          <FieldLabel>
                            {t('evaluations.forbiddenFieldPaths')}
                          </FieldLabel>
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
                          <FieldLabel>
                            {t('evaluations.forbiddenText')}
                          </FieldLabel>
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
                    <FieldLegend>{t('evaluations.toolTrajectory')}</FieldLegend>
                    <FieldDescription>
                      {t('evaluations.toolTrajectoryDescription')}
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
                    <PlusIcon data-icon='inline-start' />{' '}
                    {t('evaluations.addCall')}
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
                        {t('evaluations.strictOrder')}
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
                        {t('evaluations.strictArgs')}
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
                          {t('evaluations.expectedCall', { index: index + 1 })}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={t('evaluations.deleteExpectedCall', {
                            index: index + 1,
                          })}
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
                          <FieldLabel>{t('evaluations.tool')}</FieldLabel>
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
                              <SelectValue
                                placeholder={t(
                                  'evaluations.selectWorkflowTool',
                                )}
                              >
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
                          <FieldLabel>{t('evaluations.callCount')}</FieldLabel>
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
                          <FieldLabel>
                            {t('evaluations.expectedArgs')}
                          </FieldLabel>
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
                            {t('evaluations.assertToolResult')}
                          </Label>
                        </Field>
                        {call.assertResult ? (
                          <Field className='sm:col-span-2'>
                            <FieldLabel>
                              {t('evaluations.expectedFixtureResult')}
                            </FieldLabel>
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
                      {t('evaluations.noExpectedCalls')}
                    </p>
                  ) : null}
                </FieldGroup>
              </FieldSet>

              <FieldSet className='rounded-xl border border-dashed p-4 sm:p-5'>
                <FieldLegend>{t('evaluations.advancedAssertions')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.advancedAssertionsDescription')}
                </FieldDescription>
                <Field>
                  <FieldLabel htmlFor='evaluation-case-assertions'>
                    {t('evaluations.assertionsJson')}
                  </FieldLabel>
                  <Textarea
                    id='evaluation-case-assertions'
                    className='min-h-36 font-mono text-xs leading-5'
                    placeholder={
                      '[\n  {\n    "kind": "json_path",\n    "id": "decision-is-approved",\n    "path": "$.decision",\n    "operator": "equals",\n    "expected": "approved"\n  }\n]'
                    }
                    value={assertionsJson}
                    readOnly
                  />
                </Field>
              </FieldSet>

              <FieldSet>
                <FieldLegend>{t('evaluations.toolFixtures')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.toolFixturesDescription')}
                </FieldDescription>
                <FieldGroup className='mt-4 gap-3'>
                  {fixtureDrafts.map((fixture, index) => (
                    <div
                      key={fixture.id}
                      className='rounded-xl border bg-card p-4 shadow-sm'
                    >
                      <div className='mb-4 flex items-center justify-between'>
                        <span className='text-sm font-medium'>
                          {t('evaluations.fixture', { index: index + 1 })}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={t('evaluations.deleteFixture', {
                            index: index + 1,
                          })}
                          onClick={() =>
                            setFixtureDrafts((current) =>
                              current.filter((item) => item.id !== fixture.id),
                            )
                          }
                        >
                          <Trash2Icon />
                        </Button>
                    </div>
                      <div className='grid gap-4 md:grid-cols-2'>
                      <Field>
                        <FieldLabel>{t('evaluations.fixtureNode')}</FieldLabel>
                          <Select
                            value={fixture.nodeId || '__global__'}
                            items={[
                              {
                                value: '__global__',
                                label: t('evaluations.fixtureAnyNode'),
                              },
                              ...configuredAgentNodes.map((node) => ({
                                value: node.id,
                                label: node.label,
                              })),
                            ]}
                          onValueChange={(value) =>
                            setFixtureDrafts((current) =>
                              current.map((item) =>
                                item.id === fixture.id
                                  ? {
                                      ...item,
                                      nodeId:
                                        value === '__global__'
                                          ? ''
                                          : (value ?? ''),
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
                              <SelectItem value='__global__'>
                                {t('evaluations.fixtureAnyNode')}
                              </SelectItem>
                              {configuredAgentNodes.map((node) => (
                                <SelectItem key={node.id} value={node.id}>
                                  {node.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel>{t('evaluations.tool')}</FieldLabel>
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
                              <SelectValue
                                placeholder={t(
                                  'evaluations.selectWorkflowTool',
                                )}
                              >
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
                          <FieldLabel>
                            {t('evaluations.matchingArgsJson')}
                          </FieldLabel>
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
                        <Field>
                          <FieldLabel>
                            {t('evaluations.fixtureResultJson')}
                          </FieldLabel>
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
                          nodeId: '',
                          tool: '',
                          args: '{}',
                          result: '{}',
                        },
                      ])
                    }
                  >
                    <PlusIcon data-icon='inline-start' />{' '}
                    {t('evaluations.addFixture')}
                  </Button>
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
          </div>
          <DialogFooter className='mx-0 mb-0'>
            <Button variant='outline' onClick={() => setCaseDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={
                !caseName.trim() ||
                (!assertionDrafts.length &&
                  !toolTrajectory.calls.length &&
                  !nodeTrajectory.mustExecute.length &&
                  !nodeTrajectory.mustNotExecute.length &&
                  !nodeTrajectory.orderedNodes.length &&
                  !routeDrafts.length &&
                  !nodeOutputDrafts.length &&
                  !nodeTextDrafts.length &&
                  !nodeToolDrafts.length) ||
                saving
              }
              onClick={() => void saveCase()}
            >
              {saving ? <Spinner /> : null}{' '}
              {editingCase
                ? t('evaluations.saveChanges')
                : t('evaluations.saveCase')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(testImport)}
        onOpenChange={(open) => !open && !importing && setTestImport(undefined)}
      >
        <DialogContent className='max-w-2xl! gap-0 overflow-hidden p-0'>
          <DialogHeader className='border-b bg-linear-to-br from-sky-500/10 to-violet-500/10 px-6 py-5'>
            <DialogTitle>{t('evaluations.importPreview')}</DialogTitle>
            <DialogDescription>
              {t('evaluations.importPreviewDescription')}
            </DialogDescription>
          </DialogHeader>
          {testImport ? (
            <div className='max-h-[60vh] space-y-5 overflow-y-auto px-6 py-5'>
              <div className='rounded-lg border border-sky-500/20 bg-sky-500/5 p-3'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <span className='font-medium'>{testImport.suiteName}</span>
                  <Badge variant='outline'>
                    {t('evaluations.caseCount', {
                      count: testImport.cases.length,
                    })}
                  </Badge>
                </div>
                {testImport.suiteDescription ? (
                  <p className='text-muted-foreground mt-1 text-sm'>
                    {testImport.suiteDescription}
                  </p>
                ) : null}
              </div>
              {testImport.errors.length ? (
                <div className='border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm'>
                  {testImport.errors.map((error) => (
                    <p key={error}>• {error}</p>
                  ))}
                </div>
              ) : null}
              {suites.data?.some(
                (item) => item.name === testImport.suiteName,
              ) ? (
                <Field>
                  <FieldLabel>{t('evaluations.sameNameSuite')}</FieldLabel>
                  <Select
                    value={suiteImportStrategy}
                    onValueChange={(value) =>
                      setSuiteImportStrategy(
                        (value ?? 'create') as ImportConflictStrategy,
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='create'>
                        {t('evaluations.importSuiteCreate')}
                      </SelectItem>
                      <SelectItem value='overwrite'>
                        {t('evaluations.importSuiteOverwrite')}
                      </SelectItem>
                      <SelectItem value='skip'>
                        {t('evaluations.importSkip')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <Field>
                <FieldLabel>{t('evaluations.sameNameCase')}</FieldLabel>
                <Select
                  value={caseImportStrategy}
                  onValueChange={(value) =>
                    setCaseImportStrategy(
                      (value ?? 'create') as ImportConflictStrategy,
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='create'>
                      {t('evaluations.importCaseCreate')}
                    </SelectItem>
                    <SelectItem value='overwrite'>
                      {t('evaluations.importCaseOverwrite')}
                    </SelectItem>
                    <SelectItem value='skip'>
                      {t('evaluations.importCaseSkip')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <div className='space-y-2'>
                <p className='text-sm font-medium'>
                  {t('evaluations.caseValidation')}
                </p>
                {testImport.cases.map((item) => (
                  <div
                    key={item.index}
                    className={`rounded-lg border px-3 py-2 text-sm ${item.errors.length ? 'border-destructive/30 bg-destructive/5' : 'bg-muted/30'}`}
                  >
                    <div className='flex items-center justify-between gap-3'>
                      <span className='truncate font-medium'>{item.name}</span>
                      <Badge variant='outline'>
                        {item.errors.length
                          ? t('evaluations.invalid')
                          : t('evaluations.valid')}
                      </Badge>
                    </div>
                    {item.errors.map((error) => (
                      <p key={error} className='text-destructive mt-1 text-xs'>
                        {error}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <DialogFooter className='mx-0 mb-0'>
            <Button
              variant='outline'
              disabled={importing}
              onClick={() => setTestImport(undefined)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={
                importing ||
                !testImport ||
                testImport.errors.length > 0 ||
                testImport.cases.some((item) => item.errors.length > 0)
              }
              onClick={() => void confirmTestImport()}
            >
              {importing ? <Spinner data-icon='inline-start' /> : null}
              {t('evaluations.confirmImport')}
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
                  )?.name ?? t('evaluations.evaluationResult')}
                </DialogTitle>
                <DialogDescription className='mt-1 max-w-xl leading-5'>
                  {t('evaluations.resultSnapshotDescription')}
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
                    <span className='text-sm font-medium'>
                      {t('evaluations.resultSummary')}
                    </span>
                  </div>
                  <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                    <ResultMetric
                      label={t('evaluations.result')}
                      value={selectedResult.verdict}
                    />
                    <ResultMetric
                      label={t('evaluations.score')}
                      value={
                        selectedResult.score !== null &&
                        selectedResult.score !== undefined
                          ? `${Math.round(selectedResult.score * 100)}%`
                          : '—'
                      }
                    />
                    <ResultMetric
                      label={t('evaluations.duration')}
                      value={formatDuration(selectedResult.durationMs)}
                    />
                    <ResultMetric
                      label={t('evaluations.cost')}
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
                  <FieldLegend>{t('evaluations.actualOutput')}</FieldLegend>
                  <FieldDescription>
                    {t('evaluations.actualOutputDescription')}
                  </FieldDescription>
                  <ResultValue value={selectedResult.actualOutput} />
                </FieldSet>
                <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
                  <FieldLegend>{t('evaluations.assertionVerdict')}</FieldLegend>
                  <FieldDescription>
                    {t('evaluations.assertionVerdictDescription')}
                  </FieldDescription>
                  <ResultCriteria
                    value={selectedResult.criteriaResults}
                    expectation={
                      cases.data?.find(
                        (item) => item.id === selectedResult.evaluationCaseId,
                      )?.expectation
                    }
                    nodeNames={Object.fromEntries(
                      configuredWorkflowNodes.map((node) => [
                        node.id,
                        node.label,
                      ]),
                    )}
                    routeNames={Object.fromEntries(
                      configuredRoutes.map((route) => [
                        `${route.nodeId}:${route.route}`,
                        route.label,
                      ]),
                    )}
                  />
                </FieldSet>
                <FieldSet className='rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5'>
                  <FieldLegend>
                    {t('evaluations.executionEvidence')}
                  </FieldLegend>
                  <FieldDescription>
                    {t('evaluations.traceDescription')}
                  </FieldDescription>
                  <ResultTrace
                    value={selectedResult.normalizedTrace}
                    nodeNames={Object.fromEntries(
                      configuredWorkflowNodes.map((node) => [
                        node.id,
                        node.label,
                      ]),
                    )}
                    toolConfigured={hasToolTrajectoryAssertion(
                      selectedResult.criteriaResults,
                    )}
                    nodeConfigured={hasNodeTrajectoryAssertion(
                      selectedResult.criteriaResults,
                    )}
                  />
                </FieldSet>
                {/* Keep raw evidence available for debugging without making it the primary reading path. */}
                <details className='rounded-lg border px-3 py-2 text-xs'>
                  <summary className='cursor-pointer font-medium'>
                    {t('evaluations.viewRawEvidence')}
                  </summary>
                  <div className='mt-3 flex flex-col gap-3'>
                    <ResultJson
                      title={t('evaluations.criteriaJson')}
                      value={selectedResult.criteriaResults}
                    />
                    <ResultJson
                      title={t('evaluations.traceJson')}
                      value={selectedResult.normalizedTrace}
                    />
                  </div>
                </details>
              </div>
            ) : null}
          </div>
          <DialogFooter className='mx-0 mb-0'>
            <DialogClose render={<Button variant='outline' />}>
              {t('common.close')}
            </DialogClose>
            {selectedResult?.workflowRunId ? (
              <DialogClose
                render={<Button />}
                onClick={() => {
                  onViewWorkflowRun(selectedResult.workflowRunId!);
                }}
              >
                {t('evaluations.viewRunOutput')}
              </DialogClose>
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
      <pre className='bg-muted max-h-52 overflow-auto rounded-lg p-3 text-xs leading-5 wrap-break-word whitespace-pre-wrap'>
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

function VersionCriterionComparison({
  comparison,
  baselineLabel,
  candidateLabel,
  nodeNames,
  routeNames,
}: {
  comparison: EvaluationVersionCaseCriterionComparison;
  baselineLabel: string;
  candidateLabel: string;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  if (!comparison.criteria.length) {
    return (
      <p className='text-muted-foreground text-sm'>
        {t('evaluations.noCriteriaResults')}
      </p>
    );
  }
  return (
    <div className='flex flex-col gap-2'>
      <p className='text-muted-foreground text-xs leading-5'>
        {t('evaluations.regressionLocationDescription')}
      </p>
      {comparison.criteria.map((diff) => (
        <div
          key={diff.key}
          className={
            diff.kind === 'regressed'
              ? 'border-destructive/40 bg-destructive/5 rounded-lg border p-3'
              : 'bg-muted/30 rounded-lg border p-3'
          }
        >
          <div className='flex items-start justify-between gap-3'>
            <span className='min-w-0 text-sm font-medium'>
              {criterionLabel(
                {
                  criterion: diff.key,
                  expected: diff.baseline?.expected ?? diff.candidate?.expected,
                },
                undefined,
                t,
              )}
            </span>
            <Badge
              variant={diff.kind === 'regressed' ? 'destructive' : 'outline'}
              className='shrink-0'
            >
              {versionCriterionDiffLabel(diff, t)}
            </Badge>
          </div>
          <div className='mt-3 grid grid-cols-2 gap-2 text-xs'>
            <CriterionComparisonCell
              label={baselineLabel}
              outcome={diff.baseline}
              criterion={diff.key}
              nodeNames={nodeNames}
              routeNames={routeNames}
            />
            <CriterionComparisonCell
              label={candidateLabel}
              outcome={diff.candidate}
              criterion={diff.key}
              nodeNames={nodeNames}
              routeNames={routeNames}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function CriterionComparisonCell({
  label,
  outcome,
  criterion,
  nodeNames,
  routeNames,
}: {
  label: string;
  outcome?: EvaluationVersionCriterionDiff['baseline'];
  criterion: string;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <div className='bg-background/70 rounded-md border px-2.5 py-2'>
      <p className='text-muted-foreground truncate'>{label}</p>
      <p
        className={
          outcome == null
            ? 'text-muted-foreground mt-1'
            : outcome.passed
              ? 'mt-1 text-emerald-600 dark:text-emerald-400'
              : 'text-destructive mt-1'
        }
      >
        {outcome == null
          ? t('evaluations.assertionNotPresent')
          : outcome.passed
            ? t('evaluations.assertionPassed')
            : t('evaluations.assertionFailed')}
      </p>
      {outcome ? (
        <CriterionEvidence
          criterion={criterion}
          expected={outcome.expected}
          actual={outcome.actual}
          nodeNames={nodeNames}
          routeNames={routeNames}
        />
      ) : null}
    </div>
  );
}

function CriterionEvidence({
  criterion,
  expected,
  actual,
  nodeNames,
  routeNames,
}: {
  criterion: string;
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const actualValue = actual as Record<string, unknown>;
  const expectedValue = expected as Record<string, unknown>;
  let evidence: ReactNode;
  if (criterion.startsWith('nodeTrajectory:')) {
    const executions = Array.isArray(actualValue?.nodeExecutions)
      ? actualValue.nodeExecutions
      : [];
    evidence = executions.length ? (
      <span>
        {executions
          .map((item) => {
            const execution = item as Record<string, unknown>;
            const nodeId = String(execution.nodeId ?? '');
            return `${nodeNames[nodeId] ?? nodeId}${execution.completed === true ? ' ✓' : ' ·'}`;
          })
          .join(' → ')}
      </span>
    ) : (
      <span>{renderEvidence(actual)}</span>
    );
  } else if (criterion.startsWith('route:')) {
    const nodeId = String(expectedValue?.nodeId ?? '');
    const route = actualValue?.route;
    evidence = typeof route === 'string'
      ? <span>{routeNames[`${nodeId}:${route}`] ?? route}</span>
      : <span>{t('evaluations.routeNotRecorded')}</span>;
  } else if (criterion.startsWith('nodeToolTrajectory:')) {
    const uses = Array.isArray(actualValue?.toolUses)
      ? actualValue.toolUses
      : [];
    const names = uses
      .map((item) => String((item as Record<string, unknown>).name ?? ''))
      .filter(Boolean);
    evidence = names.length ? (
      <span>{names.join(' · ')}</span>
    ) : (
      <span>{t('evaluations.noToolCallsConfigured')}</span>
    );
  } else {
    evidence = <span>{renderEvidence(actual)}</span>;
  }
  return (
    <div className='text-muted-foreground mt-2 max-h-20 overflow-auto border-t pt-2 leading-5 wrap-break-word'>
      <span className='mr-1'>{t('evaluations.actual')}:</span>
      {evidence}
    </div>
  );
}

function ResultValue({ value }: { value: unknown }) {
  const text = (value as { text?: unknown } | undefined)?.text;
  return (
    <pre className='bg-muted mt-3 max-h-48 overflow-auto rounded-lg p-3 text-xs leading-5 wrap-break-word whitespace-pre-wrap'>
      {typeof text === 'string' ? text : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ResultCriteria({
  value,
  expectation,
  nodeNames,
  routeNames,
}: {
  value: unknown;
  expectation?: unknown;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
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
                {passed
                  ? t('evaluations.assertionPassed')
                  : t('evaluations.assertionFailed')}
              </span>
              <span className='min-w-0 flex-1 truncate text-sm font-medium'>
                {criterionLabel(item, expectation, t)}
              </span>
              <span className='text-muted-foreground text-xs'>
                {Math.round(Number(item.score ?? 0) * 100)}%
              </span>
            </div>
            {String(item.criterion).startsWith('nodeTrajectory:') ? (
              <NodeTrajectoryCriterion
                expected={item.expected}
                actual={item.actual}
                nodeNames={nodeNames}
              />
            ) : String(item.criterion).startsWith('route:') ? (
              <RouteCriterion
                expected={item.expected}
                actual={item.actual}
                nodeNames={nodeNames}
                routeNames={routeNames}
              />
            ) : String(item.criterion).startsWith('nodeOutput:') ? (
              <NodeOutputCriterion
                expected={item.expected}
                actual={item.actual}
                nodeNames={nodeNames}
              />
            ) : String(item.criterion).startsWith('nodeText:') ? (
              <NodeTextCriterion expected={item.expected} actual={item.actual} nodeNames={nodeNames} />
            ) : (
              <div className='mt-2 grid gap-2 text-xs sm:grid-cols-2'>
                <EvidenceValue
                  label={t('evaluations.expected')}
                  value={item.expected}
                />
                <EvidenceValue
                  label={t('evaluations.actual')}
                  value={item.actual}
                />
              </div>
            )}
          </div>
        );
      })}
      {!criteria.length ? (
        <p className='text-muted-foreground text-sm'>
          {t('evaluations.noCriteriaResults')}
        </p>
      ) : null}
    </div>
  );
}

function EvidenceValue({ label, value }: { label: string; value: unknown }) {
  return (
    <div className='min-w-0'>
      <p className='text-muted-foreground mb-1 font-medium'>{label}</p>
      <p className='bg-muted/60 overflow-auto rounded px-2 py-1.5 font-mono leading-5 wrap-break-word whitespace-pre-wrap'>
        {renderEvidence(value)}
      </p>
    </div>
  );
}

function RouteCriterion({
  expected,
  actual,
  nodeNames,
  routeNames,
}: {
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const expectedValue = expected as Record<string, unknown>;
  const actualValue = actual as Record<string, unknown>;
  const nodeId = String(expectedValue?.nodeId ?? '');
  const routeName = (route: unknown) =>
    typeof route === 'string'
      ? (routeNames[`${nodeId}:${route}`] ?? route)
      : t('evaluations.routeNotRecorded');
  return (
    <div className='bg-muted/30 mt-3 grid gap-3 rounded-md border p-3 text-xs sm:grid-cols-3'>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.routeNode')}
        </p>
        <p className='font-medium'>{nodeNames[nodeId] ?? nodeId}</p>
      </div>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.expectedRoute')}
        </p>
        <Badge variant='outline'>{routeName(expectedValue?.route)}</Badge>
      </div>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.actualRoute')}
        </p>
        <Badge variant='outline'>{routeName(actualValue?.route)}</Badge>
      </div>
    </div>
  );
}

function NodeOutputCriterion({
  expected,
  actual,
  nodeNames,
}: {
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const rule = expected as Record<string, unknown>;
  const nodeId = String(rule?.nodeId ?? '');
  return (
    <div className='mt-3 grid gap-3 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-3'>
      <div><p className='text-muted-foreground mb-1'>{t('evaluations.outputNode')}</p><p className='font-medium'>{nodeNames[nodeId] ?? nodeId}</p></div>
      <div><p className='text-muted-foreground mb-1'>{t('evaluations.fieldPath')}</p><p className='font-mono'>{String(rule?.path ?? '')}</p></div>
      <EvidenceValue label={t('evaluations.expected')} value={rule?.value} />
      <div className='sm:col-span-3'><EvidenceValue label={t('evaluations.actual')} value={actual} /></div>
    </div>
  );
}

function NodeTextCriterion({ expected, actual, nodeNames }: { expected: unknown; actual: unknown; nodeNames: Record<string, string> }) {
  const { t } = useTranslation();
  const rule = expected as Record<string, unknown>;
  const nodeId = String(rule?.nodeId ?? '');
  return <div className='mt-3 grid gap-3 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-3'>
    <div><p className='text-muted-foreground mb-1'>{t('evaluations.agentNode')}</p><p className='font-medium'>{nodeNames[nodeId] ?? nodeId}</p></div>
    <EvidenceValue label={t('evaluations.expectedText')} value={rule?.text} />
    <EvidenceValue label={t('evaluations.actual')} value={actual} />
  </div>;
}

function nodeIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((node): node is string => typeof node === 'string')
    : [];
}

function NodeBadges({
  ids,
  nodeNames,
}: {
  ids: string[];
  nodeNames: Record<string, string>;
}) {
  return (
    <div className='flex flex-wrap gap-1.5'>
      {ids.map((id) => (
        <Badge key={id} variant='outline'>
          {nodeNames[id] ?? id}
        </Badge>
      ))}
    </div>
  );
}

function NodeTrajectoryCriterion({
  expected,
  actual,
  nodeNames,
}: {
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const expectation = expected as Record<string, unknown>;
  const observation = actual as Record<string, unknown>;
  const required = nodeIds(expectation?.mustExecute);
  const forbidden = nodeIds(expectation?.mustNotExecute);
  const ordered = nodeIds(expectation?.orderedNodes);
  const executions = Array.isArray(observation?.nodeExecutions)
    ? observation.nodeExecutions
    : [];
  const failures = [
    ['missing', 'evaluations.missingNodes'],
    ['forbidden', 'evaluations.forbiddenNodesExecuted'],
    ['incomplete', 'evaluations.incompleteNodes'],
    ['outOfOrder', 'evaluations.outOfOrderNodes'],
  ] as const;

  return (
    <div className='mt-3 grid gap-3 text-xs'>
      <div className='bg-muted/30 grid gap-3 rounded-md border p-3'>
        {required.length || forbidden.length ? (
          <div className='grid gap-3 sm:grid-cols-2'>
            {required.length ? (
              <div>
                <p className='text-muted-foreground mb-1'>
                  {t('evaluations.requiredNodes')}
                </p>
                <NodeBadges ids={required} nodeNames={nodeNames} />
              </div>
            ) : null}
            {forbidden.length ? (
              <div>
                <p className='text-muted-foreground mb-1'>
                  {t('evaluations.forbiddenNodes')}
                </p>
                <NodeBadges ids={forbidden} nodeNames={nodeNames} />
              </div>
            ) : null}
          </div>
        ) : null}
        {required.length || forbidden.length ? (
          <div className='border-t' />
        ) : null}
        <div className='grid gap-3 sm:grid-cols-2'>
          <div>
            <p className='text-muted-foreground mb-1'>
              {t('evaluations.expectedNodePath')}
            </p>
            {ordered.length ? (
              <p>{ordered.map((id) => nodeNames[id] ?? id).join(' → ')}</p>
            ) : (
              <p className='text-muted-foreground'>
                {t('evaluations.noNodeOrder')}
              </p>
            )}
          </div>
          <div>
            <p className='text-muted-foreground mb-1'>
              {t('evaluations.actualNodePath')}
            </p>
            {executions.length ? (
              <div className='flex flex-wrap gap-1.5'>
                {executions.map((execution, index) => {
                  const item = execution as Record<string, unknown>;
                  const id = String(item.nodeId ?? '');
                  return (
                    <Badge key={`${id}-${index}`} variant='outline'>
                      {nodeNames[id] ?? id}{' '}
                      {item.completed === true ? '✓' : '○'}
                    </Badge>
                  );
                })}
              </div>
            ) : (
              <p className='text-muted-foreground'>
                {t('evaluations.noNodeExecutions')}
              </p>
            )}
          </div>
        </div>
        {!required.length && !forbidden.length && !ordered.length ? (
          <p className='text-muted-foreground'>
            {t('evaluations.noNodeRules')}
          </p>
        ) : null}
      </div>
      {failures.flatMap(([key, translation]) => {
        const ids = nodeIds(observation?.[key]);
        return ids.length
          ? [
              <div
                key={key}
                className='text-destructive flex flex-wrap items-center gap-2'
              >
                <span>{t(translation)}:</span>
                <NodeBadges ids={ids} nodeNames={nodeNames} />
              </div>,
            ]
          : [];
      })}
    </div>
  );
}

function ResultTrace({
  value,
  nodeNames,
  toolConfigured,
  nodeConfigured,
}: {
  value: unknown;
  nodeNames: Record<string, string>;
  toolConfigured: boolean;
  nodeConfigured: boolean;
}) {
  const { t } = useTranslation();
  const trace = value as
    | { toolUses?: unknown[]; nodeExecutions?: unknown[] }
    | undefined;
  const tools = Array.isArray(trace?.toolUses) ? trace.toolUses : [];
  const nodes = Array.isArray(trace?.nodeExecutions)
    ? trace.nodeExecutions
    : [];
  return (
    <div className='mt-3'>
      {nodes.length ? (
        <div className='mb-3 flex flex-wrap items-center gap-2'>
          {nodes.map((node, index) => {
            const item = node as Record<string, unknown>;
            return (
              <Badge key={`${String(item.nodeId)}-${index}`} variant='outline'>
                {nodeNames[String(item.nodeId)] ?? String(item.nodeId)}{' '}
                {item.completed === true ? '✓' : '○'}
              </Badge>
            );
          })}
        </div>
      ) : null}
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
      ) : !nodes.length ? (
        <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
          {toolConfigured
            ? t('evaluations.noToolCallsConfigured')
            : nodeConfigured
              ? t('evaluations.noNodeExecutions')
              : t('evaluations.noExecutionEvidenceConfigured')}
        </p>
      ) : null}
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

function hasNodeTrajectoryAssertion(value: unknown) {
  return (
    Array.isArray(value) &&
    value.some(
      (criterion) =>
        typeof criterion === 'object' &&
        criterion !== null &&
        String((criterion as Record<string, unknown>).criterion).startsWith(
          'nodeTrajectory:',
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
  t?: (key: string, options?: Record<string, unknown>) => string,
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
      ? (t?.('evaluations.outputField', { path }) ?? `Output field ${path}`)
      : typeof legacyPath === 'string'
        ? (t?.('evaluations.outputField', { path: legacyPath }) ??
          `Output field ${legacyPath}`)
        : (t?.('evaluations.outputFieldAssertion') ?? 'Output field assertion');
  }
  if (id.startsWith('text:'))
    return t?.('evaluations.finalOutputText') ?? 'Final output text';
  if (id.startsWith('toolTrajectory:'))
    return t?.('evaluations.toolTrajectory') ?? 'Tool trajectory';
  if (id.startsWith('nodeTrajectory:'))
    return t?.('evaluations.nodeTrajectory') ?? 'Node path';
  if (id.startsWith('route:'))
    return t?.('evaluations.routeAssertions') ?? 'Route assertion';
  if (id.startsWith('nodeOutput:'))
    return t?.('evaluations.nodeOutputAssertions') ?? 'Node output assertion';
  if (id.startsWith('nodeText:'))
    return t?.('evaluations.agentMessageAssertions') ?? 'Agent message assertion';
  if (id.startsWith('nodeToolTrajectory:'))
    return t?.('evaluations.nodeToolAssertions') ?? 'Node tool assertion';
  if (id.startsWith('safety:'))
    return t?.('evaluations.safetyAssertions') ?? 'Safety assertion';
  return t?.('evaluations.assertion') ?? 'Assertion';
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

function versionDiffLabel(
  diff: EvaluationVersionCaseDiff,
  t: (key: string) => string,
) {
  return t(`evaluations.versionDiff.${diff.kind}`);
}

function versionCriterionDiffLabel(
  diff: EvaluationVersionCriterionDiff,
  t: (key: string) => string,
) {
  return t(`evaluations.criterionDiff.${diff.kind}`);
}

function EvaluationTrends({
  runs,
  versions,
}: {
  runs: EvaluationRunDetail[];
  versions: EvaluationVersionSummary[];
}) {
  const { t } = useTranslation();
  const completed = runs.filter((run) => run.status === 'completed');
  if (!completed.length) return null;
  const average = (values: number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  const passRates = completed.map((run) =>
    run.totalCases ? (run.passedCases / run.totalCases) * 100 : 0,
  );
  const averageCost = average(
    completed.map((run) => run.estimatedCostMicrousd ?? 0),
  );
  const averageDuration = average(completed.map((run) => run.durationMs ?? 0));
  const failedRuns = completed.filter((run) => run.failedCases > 0).length;

  return (
    <div className='mt-5 border-t pt-4'>
      <div className='mb-3 flex items-center justify-between'>
        <div>
          <div className='text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase'>
            {t('evaluations.qualityTrends')}
          </div>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {t('evaluations.completedRuns', { count: completed.length })}
          </p>
        </div>
        <Badge variant='outline' className='text-[10px]'>
          {failedRuns
            ? t('evaluations.failedRuns', { count: failedRuns })
            : t('evaluations.stable')}
        </Badge>
      </div>
      <div className='grid grid-cols-3 gap-2'>
        <TrendMetric
          label={t('evaluations.averagePassRate')}
          value={`${Math.round(average(passRates))}%`}
        />
        <TrendMetric
          label={t('evaluations.averageCost')}
          value={formatCost(averageCost)}
        />
        <TrendMetric
          label={t('evaluations.averageDuration')}
          value={formatDuration(averageDuration)}
        />
      </div>
      <div className='bg-background/60 mt-3 rounded-lg border p-3'>
        <div className='text-muted-foreground mb-2 text-[10px] font-medium'>
          {t('evaluations.passRateTrend')}
        </div>
        <div
          className='flex h-16 items-end gap-1'
          aria-label={t('evaluations.passRateTrendAria')}
        >
          {completed
            .slice(0, 16)
            .reverse()
            .map((run) => {
              const rate = run.totalCases
                ? (run.passedCases / run.totalCases) * 100
                : 0;
              return (
                <div
                  key={run.id}
                  title={`${new Date(run.startedAt).toLocaleString()}：${Math.round(rate)}%`}
                  className='bg-muted flex h-full min-w-1 flex-1 items-end overflow-hidden rounded-sm'
                >
                  <div
                    className={
                      rate === 100
                        ? 'w-full bg-emerald-500'
                        : rate >= 80
                          ? 'w-full bg-amber-500'
                          : 'w-full bg-rose-500'
                    }
                    style={{ height: `${Math.max(rate, 4)}%` }}
                  />
                </div>
              );
            })}
        </div>
        <div className='text-muted-foreground mt-1 flex justify-between text-[10px]'>
          <span>{t('evaluations.earlier')}</span>
          <span>{t('evaluations.latest')}</span>
        </div>
      </div>
      {versions.length > 1 ? (
        <div className='mt-3 space-y-1.5'>
          <div className='text-muted-foreground text-[10px] font-medium'>
            {t('evaluations.versionPerformance')}
          </div>
          {versions.slice(0, 4).map((version) => (
            <div
              key={versionKey(version)}
              className='flex items-center justify-between gap-2 text-xs'
            >
              <span className='truncate font-medium'>
                {version.releaseVersion}
              </span>
              <span className='text-muted-foreground shrink-0'>
                {versionPassRate(version)}% ·{' '}
                {formatCost(version.estimatedCostMicrousd)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TrendMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className='bg-muted/40 rounded-md px-2 py-2 text-center'>
      <div className='text-muted-foreground text-[10px]'>{label}</div>
      <div className='mt-0.5 text-xs font-semibold'>{value}</div>
    </div>
  );
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
