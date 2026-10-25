import { normalizeWorkflowNodeName } from '@/lib/workflow-node-name';
import type { WorkflowDocument } from '@/services/workflow';

export type FieldChange = { path: string; before: unknown; after: unknown };
export type WorkflowChange = {
  id: string;
  kind: 'node' | 'edge' | 'settings' | 'layout';
  status: 'added' | 'removed' | 'modified';
  label: string;
  nodeIds: string[];
  fields: FieldChange[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const setFields = new Set([
  'toolIds',
  'attachmentPaths',
  'readers',
  'rawReaders',
  'globalKeys',
  'sensitiveFields',
  'sessionStateFields',
  'contextKeys',
]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function fieldChanges(
  before: unknown,
  after: unknown,
  path = '',
): FieldChange[] {
  if (canonical(before) === canonical(after)) return [];
  if (
    (object(before) && (object(after) || after === undefined)) ||
    (object(after) && before === undefined)
  ) {
    const left = object(before) ? before : {};
    const right = object(after) ? after : {};
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    if (keys.length)
      return keys.flatMap((key) =>
        fieldChanges(left[key], right[key], path ? `${path}.${key}` : key),
      );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const key = path.split('.').at(-1)!;
    if (setFields.has(key) || key === 'skillRefs') {
      if (
        before.map(canonical).sort().join('\n') ===
        after.map(canonical).sort().join('\n')
      )
        return [];
    }
    // Stable IDs keep one edited input or branch from looking like a replaced array.
    const items = [...before, ...after];
    if (
      items.length &&
      items.every((item) => object(item) && typeof item.id === 'string') &&
      new Set(before.map((item) => item.id)).size === before.length &&
      new Set(after.map((item) => item.id)).size === after.length
    ) {
      const left = new Map(before.map((item) => [item.id, item]));
      const right = new Map(after.map((item) => [item.id, item]));
      const changes = [...new Set([...left.keys(), ...right.keys()])].flatMap(
        (id) => fieldChanges(left.get(id), right.get(id), `${path}[${id}]`),
      );
      const commonBefore = before
        .filter((item) => right.has(item.id))
        .map((item) => item.id);
      const commonAfter = after
        .filter((item) => left.has(item.id))
        .map((item) => item.id);
      if (canonical(commonBefore) !== canonical(commonAfter))
        changes.push({
          path: `${path}.order`,
          before: commonBefore,
          after: commonAfter,
        });
      return changes;
    }
  }
  return [{ path, before, after }];
}
export function nodeName(node: WorkflowDocument['nodes'][number]) {
  const label = [
    node.data.name,
    node.data.title,
    node.data.label,
    node.data.workflowName,
  ].find((value) => typeof value === 'string' && value.trim());
  return typeof label === 'string' ? label : (node.type ?? node.id);
}
export function edgeKey(edge: WorkflowDocument['edges'][number]) {
  return JSON.stringify([
    edge.source,
    edge.sourceHandle ?? null,
    edge.target,
    edge.targetHandle ?? null,
  ]);
}
export function diffWorkflow(
  before: WorkflowDocument,
  after: WorkflowDocument,
): WorkflowChange[] {
  const changes: WorkflowChange[] = [];
  const left = new Map(before.nodes.map((node) => [node.id, node]));
  const right = new Map(after.nodes.map((node) => [node.id, node]));
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    const previous = left.get(id),
      next = right.get(id);
    const node = next ?? previous!;
    const fields = fieldChanges(
      previous && {
        type: previous.type,
        data: normalizeWorkflowNodeName(previous).data,
      },
      next && { type: next.type, data: normalizeWorkflowNodeName(next).data },
    );
    if (fields.length)
      changes.push({
        id: `node:${id}`,
        kind: 'node',
        status: !previous ? 'added' : !next ? 'removed' : 'modified',
        label: nodeName(node),
        nodeIds: [id],
        fields,
      });
    if (previous && next) {
      const layout = (item: typeof node) => ({
        position: item.position,
        parentId: item.parentId,
        style: item.style,
      });
      const fields = fieldChanges(layout(previous), layout(next));
      if (fields.length)
        changes.push({
          id: `layout:${id}`,
          kind: 'layout',
          status: 'modified',
          label: nodeName(node),
          nodeIds: [id],
          fields,
        });
    }
  }
  const previousEdges = new Map(
    before.edges.map((edge) => [edgeKey(edge), edge]),
  );
  const nextEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
  for (const key of new Set([...previousEdges.keys(), ...nextEdges.keys()])) {
    const previous = previousEdges.get(key),
      next = nextEdges.get(key);
    const semantic = (edge: typeof previous) =>
      edge && {
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        label: edge.label,
      };
    const fields = fieldChanges(semantic(previous), semantic(next));
    if (!fields.length) continue;
    const edge = next ?? previous!;
    const names = next ? right : left;
    const name = (id: string) =>
      names.has(id) ? nodeName(names.get(id)!) : id;
    changes.push({
      id: `edge:${key}`,
      kind: 'edge',
      status: !previous ? 'added' : !next ? 'removed' : 'modified',
      label: `${name(edge.source)}${edge.sourceHandle ? ` / ${edge.sourceHandle}` : ''} → ${name(edge.target)}`,
      nodeIds: [edge.source, edge.target],
      fields,
    });
  }
  const fields = fieldChanges(before.settings, after.settings);
  if (fields.length)
    changes.push({
      id: 'settings',
      kind: 'settings',
      status: 'modified',
      label: '',
      nodeIds: [],
      fields,
    });
  return changes.sort(
    (a, b) => Number(a.kind === 'layout') - Number(b.kind === 'layout'),
  );
}

// Never render credentials, including values nested inside a newly added node.
export function safeValue(value: unknown, path = ''): unknown {
  if (value === undefined) return undefined;
  if (
    /(authentication|credentials|password|secret|token|api[_-]?key|authorization|environment)(\.|\[|$)/i.test(
      path,
    )
  )
    return '••••••';
  if (Array.isArray(value)) return value.map((item) => safeValue(item, path));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        safeValue(item, `${path}.${key}`),
      ]),
    );
  return value;
}

export type TextDiffLine = { kind: 'same' | 'added' | 'removed'; text: string };
export function diffLines(before: string, after: string): TextDiffLine[] {
  const a = before.split('\n'),
    b = after.split('\n');
  // Bound memory for generated instructions; large values still get a faithful before/after view.
  if (a.length * b.length > 250_000)
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  const table = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const result: TextDiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i++] });
      j++;
    } else if (
      j < b.length &&
      (i === a.length || table[i][j + 1] > table[i + 1][j])
    )
      result.push({ kind: 'added', text: b[j++] });
    else result.push({ kind: 'removed', text: a[i++] });
  }
  return result;
}
