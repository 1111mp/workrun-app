import type { TFunction } from 'i18next';

import type {
  EvaluationCase,
  EvaluationWorkflowSnapshot,
} from '@/services/evaluation';
import type { ToolDefinition } from '@/services/tool';

import type { WorkflowRouteOption } from './types';

export function workflowToolIds(snapshot: EvaluationWorkflowSnapshot) {
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

export function toolLabel(tool: ToolDefinition) {
  return tool.sourceName
    ? `${tool.sourceName} · ${tool.displayName}`
    : tool.displayName;
}

export function selectedToolLabel(name: string, tools: ToolDefinition[]) {
  const tool = tools.find((candidate) => candidate.name === name);
  return tool ? toolLabel(tool) : name;
}

export function workflowEvaluationNodes(
  snapshot: EvaluationWorkflowSnapshot,
  t: TFunction,
) {
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
    const nodeType = typeof node.type === 'string' ? node.type : 'unknown';
    if (
      typeof node.id !== 'string' ||
      !node.id ||
      ['start', 'end', 'group'].includes(nodeType)
    )
      return [];
    // Node names live under different fields by node type; selectors should
    // prefer the canvas label so assertions remain understandable to users.
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
      t(`workflowEditor.inspector.nodes.${nodeType}`, {
        defaultValue: t('workflowEditor.inspector.untitledNode'),
      });
    return [{ id: node.id, label }];
  });
}

export function workflowRoutes(
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

export function workflowAgentNodes(snapshot: EvaluationWorkflowSnapshot) {
  const dsl = snapshot.dsl as {
    nodes?: Array<{
      id?: unknown;
      type?: unknown;
      data?: { name?: unknown; label?: unknown };
    }>;
  };
  return (dsl.nodes ?? []).flatMap((node) => {
    if (
      typeof node.id !== 'string' ||
      !['agent', 'codeact_agent', 'remote_agent'].includes(String(node.type))
    )
      return [];
    const label =
      [node.data?.name, node.data?.label]
        .find(
          (value): value is string =>
            typeof value === 'string' && Boolean(value.trim()),
        )
        ?.trim() ?? node.id;
    return [{ id: node.id, label }];
  });
}

export function evaluationCoverage(
  cases: EvaluationCase[],
  nodes: Array<{ id: string; label: string }>,
  routes: WorkflowRouteOption[],
) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const routeKeys = new Set(
    routes.map((route) => `${route.nodeId}:${route.route}`),
  );
  const coveredNodes = new Set<string>();
  const coveredRoutes = new Set<string>();
  const stale = new Set<string>();
  for (const item of cases.filter((item) => item.enabled && !item.archived)) {
    const assertions = (
      item.expectation as { assertions?: unknown } | undefined
    )?.assertions;
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
          if (Array.isArray(ids))
            ids.forEach(
              (id) =>
                typeof id === 'string' &&
                (nodeIds.has(id) ? coveredNodes.add(id) : stale.add(id)),
            );
        }
      }
      if (
        value.kind === 'route' &&
        typeof nodeId === 'string' &&
        typeof value.expectedRoute === 'string'
      ) {
        const key = `${nodeId}:${value.expectedRoute}`;
        if (routeKeys.has(key)) coveredRoutes.add(key);
        else stale.add(`${nodeId}:${value.expectedRoute}`);
      }
    }
  }
  return {
    coveredNodes,
    coveredRoutes,
    missingNodes: nodes.filter((node) => !coveredNodes.has(node.id)),
    missingRoutes: routes.filter(
      (route) => !coveredRoutes.has(`${route.nodeId}:${route.route}`),
    ),
    stale: [...stale],
  };
}
