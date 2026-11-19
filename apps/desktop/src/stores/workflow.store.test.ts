import { EdgeChangeset, NodeChangeset } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { createWorkflowStore } from './workflow.store';

function createStore() {
  return createWorkflowStore({
    nodes: ['start', 'end'].map((id) => ({
      id,
      position: { x: 0, y: 0 },
      data: {},
    })),
    edges: [{ id: 'edge', source: 'start', target: 'end' }],
    settings: {
      name: 'Workflow',
      description: '',
      mode: 'task',
      inputSchema: { fields: [] },
    },
  });
}

describe('React Flow 13 changesets', () => {
  it('removes connected edges with a node and restores both in one undo', () => {
    const store = createStore();
    store
      .getState()
      .onNodesChange(new NodeChangeset([{ type: 'remove', id: 'end' }]));
    store
      .getState()
      .onEdgesChange(new EdgeChangeset([{ type: 'remove', id: 'edge' }]));
    expect(store.getState().nodes.map((node) => node.id)).toEqual(['start']);
    expect(store.getState().edges).toEqual([]);
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    store.temporal.getState().undo();
    expect(store.getState().nodes).toHaveLength(2);
    expect(store.getState().edges).toHaveLength(1);
    store.temporal.getState().redo();
    expect(store.getState().nodes).toHaveLength(1);
    expect(store.getState().edges).toEqual([]);
  });

  it('groups multiple drag updates into one undo step', () => {
    const store = createStore();
    store.getState().startNodeDrag();
    for (const x of [10, 20, 30]) {
      store.getState().onNodesChange(
        new NodeChangeset([
          {
            type: 'position',
            id: 'start',
            position: { x, y: 10 },
            dragging: true,
          },
        ]),
      );
    }
    store.getState().finishNodeDrag();
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    expect(store.getState().nodes[0].position).toEqual({ x: 30, y: 10 });
    store.temporal.getState().undo();
    expect(store.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
    store.temporal.getState().redo();
    expect(store.getState().nodes[0].position).toEqual({ x: 30, y: 10 });
  });

  it('applies measurements and selections without mutating the input snapshot', () => {
    const store = createStore();
    const original = store.getState().nodes;
    store.getState().onNodesChange(
      new NodeChangeset([
        {
          type: 'dimensions',
          id: 'start',
          dimensions: { width: 200, height: 80 },
        },
        { type: 'select', id: 'start', selected: true },
      ]),
    );
    store
      .getState()
      .onEdgesChange(
        new EdgeChangeset([{ type: 'select', id: 'edge', selected: true }]),
      );
    expect(store.getState().nodes[0].measured).toEqual({
      width: 200,
      height: 80,
    });
    expect(store.getState().nodes[0].selected).toBe(true);
    expect(store.getState().edges[0].selected).toBe(true);
    expect(original[0].measured).toBeUndefined();
    expect(original[0].selected).toBeUndefined();
  });
});
