import { renderHook } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { expect, it } from 'vitest';

import type { RunRecord } from '@/services/run-history';
import { useWorkflowRunStore } from '@/stores/workflow-run.store';

import { useWorkflowRunSnapshot } from './use-workflow-run-snapshot';

const node: Node = {
  id: 'agent',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { name: 'Agent' },
};

function record(id = 'restored'): RunRecord {
  return {
    id,
    input: { input: 'hello' },
    runtime: {},
    events: [
      { sequence: 0, event: { type: 'node_start', node: 'agent', step: 0 } },
    ],
  } as unknown as RunRecord;
}

it('does not rewind live output on query refresh, node selection, or a later run', async () => {
  useWorkflowRunStore.getState().resetRunView();
  const rendered = renderHook(
    ({ snapshot, nodes }: { snapshot: RunRecord; nodes: Node[] }) =>
      useWorkflowRunSnapshot(snapshot, nodes, 'task', true),
    { initialProps: { snapshot: record(), nodes: [node] } },
  );
  const render = (snapshot: RunRecord, nodes = [node]) =>
    rendered.rerender({ snapshot, nodes });
  try {
    useWorkflowRunStore.getState().applyRunEvents(
      [
        {
          runId: 'restored',
          sequence: 1,
          event: {
            type: 'message',
            node: 'agent',
            content: 'Streamed response',
            is_final: true,
          },
        },
      ],
      { mode: 'task', nodes: [node] },
    );
    const streamed = useWorkflowRunStore.getState().projection;
    useWorkflowRunStore.getState().setRunPanelOpen(false);
    render(record(), [{ ...node, selected: true }]);
    expect(useWorkflowRunStore.getState().projection).toBe(streamed);
    expect(useWorkflowRunStore.getState().runPanelOpen).toBe(false);
    const updated = record();
    updated.events.push({
      sequence: 2,
      event: { type: 'node_start', node: 'next', step: 1 },
      createdAt: '2026-10-11T00:00:00Z',
    });
    render(updated);
    const caughtUp = useWorkflowRunStore.getState().projection;
    expect(caughtUp.eventSequence).toBe(2);
    expect(caughtUp.executionsById[streamed.executionIds[0]]).toBe(
      streamed.executionsById[streamed.executionIds[0]],
    );
    expect(useWorkflowRunStore.getState().runPanelOpen).toBe(false);
    useWorkflowRunStore.getState().startWorkflowRun('new-run', {}, 'task');
    const next = useWorkflowRunStore.getState().projection;
    render(record());
    expect(useWorkflowRunStore.getState().projection).toBe(next);
    render(record('another'));
    expect(useWorkflowRunStore.getState().projection.runId).toBe('another');
  } finally {
    rendered.unmount();
  }
});
