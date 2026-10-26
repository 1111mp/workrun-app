import { describe, expect, it } from 'vitest';

import type { WorkflowDocument } from '@/services/workflow';

import { diffLines, diffWorkflow, fieldChanges, safeValue } from './diff';
const document = (): WorkflowDocument => ({
  settings: {
    name: 'Test',
    description: '',
    mode: 'task',
    inputSchema: { fields: [] },
  },
  nodes: [
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { name: 'Agent', instruction: 'Review', toolIds: ['one', 'two'] },
    },
  ],
  edges: [],
});
describe('workflow semantic diff', () => {
  it('ignores editor measurements, object key order, tool ordering and regenerated edge IDs', () => {
    const before = document(),
      after = structuredClone(before);
    before.edges = [{ id: 'old', source: 'a', target: 'a' }];
    after.edges = [{ id: 'new', source: 'a', target: 'a', sourceHandle: null }];
    after.nodes[0].selected = true;
    after.nodes[0].measured = { width: 200 };
    after.nodes[0].data = {
      toolIds: ['two', 'one'],
      instruction: 'Review',
      name: 'Agent',
    };
    expect(diffWorkflow(before, after)).toEqual([]);
  });
  it('separates layout from edited instructions and preserves input snapshots', () => {
    const before = document(),
      after = structuredClone(before);
    after.nodes[0].position.x = 300;
    after.nodes[0].data.instruction = 'Review carefully';
    const copy = structuredClone({ before, after });
    const changes = diffWorkflow(before, after);
    expect(changes.map((item) => item.kind)).toEqual(['node', 'layout']);
    expect(changes[0].fields).toEqual([
      { path: 'data.instruction', before: 'Review', after: 'Review carefully' },
    ]);
    expect({ before, after }).toEqual(copy);
  });
  it('includes deleted nodes, rewired branches and workflow settings', () => {
    const before = document(),
      after = document();
    before.edges = [
      { id: '1', source: 'a', target: 'a', sourceHandle: 'true' },
    ];
    after.nodes = [
      {
        id: 'b',
        type: 'end',
        position: { x: 0, y: 0 },
        data: { label: 'End' },
      },
    ];
    after.edges = [
      { id: '1', source: 'b', target: 'b', sourceHandle: 'false' },
    ];
    after.settings.name = 'Changed';
    expect(
      diffWorkflow(before, after).map((item) => [item.kind, item.status]),
    ).toEqual([
      ['node', 'removed'],
      ['node', 'added'],
      ['edge', 'removed'],
      ['edge', 'added'],
      ['settings', 'modified'],
    ]);
  });
  it('matches branch IDs and reports order independently of field edits', () => {
    const a = [
      { id: 'one', condition: 'a' },
      { id: 'two', condition: 'b' },
    ];
    const b = [
      { id: 'two', condition: 'c' },
      { id: 'one', condition: 'a' },
    ];
    expect(fieldChanges(a, b, 'cases').map((item) => item.path)).toEqual([
      'cases[two].condition',
      'cases.order',
    ]);
  });
  it('masks nested credentials and environment values, while retaining ordinary configuration', () => {
    const value = {
      data: {
        name: 'Agent',
        authentication: { token: 'never show' },
        environment: [{ name: 'TOKEN', value: 'secret' }],
      },
    };
    expect(JSON.stringify(safeValue(value))).not.toMatch(/never show|secret/);
    expect(safeValue('secret', 'data.authentication.token')).toBe('••••••');
    expect(safeValue(value)).toMatchObject({ data: { name: 'Agent' } });
  });
  it('produces readable line changes including unchanged context', () => {
    expect(diffLines('first\nold\nlast', 'first\nnew\nlast')).toEqual([
      { kind: 'same', text: 'first' },
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' },
      { kind: 'same', text: 'last' },
    ]);
  });
});

it('compares legacy Agent labels as names without reporting storage migration noise', () => {
  const before = document(),
    after = document();
  before.nodes[0].data = { name: '', label: '旧名称' };
  after.nodes[0].data = { name: '新名称' };
  const changes = diffWorkflow(before, after);
  expect(changes[0].fields).toEqual([
    { path: 'data.name', before: '旧名称', after: '新名称' },
  ]);
  after.nodes[0].data = { name: '旧名称' };
  expect(diffWorkflow(before, after)).toEqual([]);
  expect(before.nodes[0].data.label).toBe('旧名称');
});
