import { expect, it } from 'vitest';

import { createWorkflowStore } from '@/stores/workflow.store';

import { normalizeWorkflowNodeName } from './workflow-node-name';

it.each(['agent', 'codeact_agent'])(
  'opens legacy %s names in the editor and preserves snapshots',
  (type) => {
    const node = {
      id: 'a',
      type,
      position: { x: 0, y: 0 },
      data: {
        name: '',
        label: '销售指标计算',
        instruction: 'Keep this instruction',
      },
    };
    const store = createWorkflowStore({
      nodes: [node],
      edges: [],
      settings: {
        name: 'Workflow',
        description: '',
        mode: 'task',
        inputSchema: { fields: [] },
      },
    });
    expect(store.getState().nodes[0].data).toEqual({
      name: '销售指标计算',
      instruction: 'Keep this instruction',
    });
    expect(node.data).toHaveProperty('label', '销售指标计算');
    expect(node.data.name).toBe('');
    store.getState().updateNodeData('a', { name: '' });
    expect(normalizeWorkflowNodeName(store.getState().nodes[0]).data.name).toBe(
      '',
    );
    store.getState().replaceWorkflow({
      nodes: [{ ...node, data: { label: '新的名称' } }],
      edges: [],
      settings: store.getState().settings,
    });
    expect(store.getState().nodes[0].data).toEqual({ name: '新的名称' });
  },
);
it('prefers canonical names and leaves branch labels alone', () => {
  expect(
    normalizeWorkflowNodeName({
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { name: 'Current', label: 'Legacy' },
    }).data,
  ).toEqual({ name: 'Current' });
  const branch = {
    id: 'a',
    type: 'switch',
    position: { x: 0, y: 0 },
    data: { label: '判断金额' },
  };
  expect(normalizeWorkflowNodeName(branch)).toBe(branch);
});
