import type { TFunction } from 'i18next';

import type {
  AssertionOperator,
  MatchAlgorithm,
  NodeOutputAssertionDraft,
  NodeTextAssertionDraft,
  NodeToolAssertionDraft,
  NodeTrajectoryDraft,
  RouteAssertionDraft,
  SafetyAssertionDraft,
  SafetyTarget,
  TestImportPreview,
  ToolCallDraft,
  ToolFixtureDraft,
  ToolTrajectoryDraft,
  VisualAssertion,
} from './types';

export function jsonObject(value: string, label: string, t: TFunction) {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(t('evaluations.jsonObjectRequired', { label }));
  }
  return parsed;
}

export function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function testImportPreview(
  value: unknown,
  t: TFunction,
): TestImportPreview {
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

export function visualAssertions(value: unknown): VisualAssertion[] {
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

export function toolCallDraft(call?: Record<string, unknown>): ToolCallDraft {
  return {
    id: crypto.randomUUID(),
    name: typeof call?.name === 'string' ? call.name : '',
    args: JSON.stringify(call?.args ?? {}, null, 2),
    count: 1,
    assertResult: call?.expectedResponse !== undefined,
    expectedResult: JSON.stringify(call?.expectedResponse ?? {}, null, 2),
  };
}

export function toolTrajectoryDraft(value: unknown): ToolTrajectoryDraft {
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

export function nodeTrajectoryDraft(value: unknown): NodeTrajectoryDraft {
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

export function routeAssertionDrafts(value: unknown): RouteAssertionDraft[] {
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

export function nodeOutputAssertionDrafts(
  value: unknown,
): NodeOutputAssertionDraft[] {
  const assertions = (value as { assertions?: unknown } | undefined)
    ?.assertions;
  return Array.isArray(assertions)
    ? assertions.flatMap((assertion) => {
        if (!assertion || typeof assertion !== 'object') return [];
        const item = assertion as Record<string, unknown>;
        return item.kind === 'node_output' &&
          typeof item.nodeId === 'string' &&
          typeof item.path === 'string' &&
          typeof item.operator === 'string'
          ? [
              {
                id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
                nodeId: item.nodeId,
                path: item.path,
                operator: item.operator as NodeOutputAssertionDraft['operator'],
                expected:
                  typeof item.expected === 'string'
                    ? item.expected
                    : (JSON.stringify(item.expected) ?? ''),
              },
            ]
          : [];
      })
    : [];
}

export function nodeTextAssertionDrafts(
  value: unknown,
): NodeTextAssertionDraft[] {
  const assertions = (value as { assertions?: unknown } | undefined)
    ?.assertions;
  return Array.isArray(assertions)
    ? assertions.flatMap((assertion) => {
        if (!assertion || typeof assertion !== 'object') return [];
        const item = assertion as Record<string, unknown>;
        return item.kind === 'node_text' &&
          typeof item.nodeId === 'string' &&
          typeof item.expected === 'string'
          ? [
              {
                id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
                nodeId: item.nodeId,
                algorithm: item.algorithm as MatchAlgorithm,
                expected: item.expected,
              },
            ]
          : [];
      })
    : [];
}

export function nodeToolAssertionDrafts(
  value: unknown,
): NodeToolAssertionDraft[] {
  const assertions = (value as { assertions?: unknown } | undefined)
    ?.assertions;
  return Array.isArray(assertions)
    ? assertions.flatMap((assertion) => {
        if (!assertion || typeof assertion !== 'object') return [];
        const item = assertion as Record<string, unknown>;
        const tools = Array.isArray(item.tools) ? item.tools : [];
        const tool = tools[0] as Record<string, unknown> | undefined;
        return item.kind === 'node_tool_trajectory' &&
          typeof item.nodeId === 'string' &&
          typeof tool?.name === 'string'
          ? [
              {
                id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
                nodeId: item.nodeId,
                toolName: tool.name,
                count: Math.max(1, tools.length),
              },
            ]
          : [];
      })
    : [];
}

export function toolFixtureDrafts(value: unknown): ToolFixtureDraft[] {
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

export function safetyAssertionDrafts(value: unknown): SafetyAssertionDraft[] {
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

export function safetyAssertions(drafts: SafetyAssertionDraft[]) {
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

export function trajectoryAssertion(draft: ToolTrajectoryDraft, t: TFunction) {
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

export function nodeTrajectoryAssertion(draft: NodeTrajectoryDraft) {
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

export function routeAssertions(drafts: RouteAssertionDraft[]) {
  return drafts.map((draft) => ({
    kind: 'route',
    id: draft.id,
    nodeId: draft.nodeId,
    expectedRoute: draft.expectedRoute,
  }));
}

export function nodeOutputAssertions(drafts: NodeOutputAssertionDraft[]) {
  return drafts.map((draft) => ({
    kind: 'node_output',
    id: draft.id,
    nodeId: draft.nodeId,
    path: draft.path,
    operator: draft.operator,
    expected: draft.expected,
  }));
}

export function nodeTextAssertions(drafts: NodeTextAssertionDraft[]) {
  return drafts.map((draft) => ({
    kind: 'node_text',
    id: draft.id,
    nodeId: draft.nodeId,
    algorithm: draft.algorithm,
    expected: draft.expected,
    threshold: draft.algorithm === 'levenshtein' ? 0.8 : 1,
  }));
}

export function nodeToolAssertions(drafts: NodeToolAssertionDraft[]) {
  return drafts.map((draft) => ({
    kind: 'node_tool_trajectory',
    id: draft.id,
    nodeId: draft.nodeId,
    tools: Array.from({ length: draft.count }, () => ({
      name: draft.toolName,
      args: {},
    })),
    config: { strictOrder: true, strictArgs: false },
  }));
}

export function fixturesFromDrafts(drafts: ToolFixtureDraft[], t: TFunction) {
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

export function expectationFromVisualAssertions(
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

export function serializeVisualAssertions(
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
