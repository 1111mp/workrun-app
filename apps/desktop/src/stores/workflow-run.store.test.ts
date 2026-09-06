import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { WorkflowRunEvent } from '@/services/workflow';

import { replayWorkflowRunView, restoreWorkflowRunView } from './workflow-run.store';

const node: Node = {
  id: 'research',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { name: 'Research' },
};

describe('replayWorkflowRunView', () => {
  it('uses terminal lifecycle metadata from the archived run', () => {
    const view = restoreWorkflowRunView(
      { status: 'running', startedAt: 1000 },
      {
        status: 'cancelled',
        startedAt: '2026-09-06T13:26:34.192Z',
        endedAt: '2026-09-06T13:26:40.684Z',
        durationMs: 6492,
        error: 'Cancelled by user',
      },
    );

    expect(view).toMatchObject({
      status: 'cancelled',
      startedAt: Date.parse('2026-09-06T13:26:34.192Z'),
      endedAt: Date.parse('2026-09-06T13:26:40.684Z'),
      durationMs: 6492,
      error: undefined,
    });
  });

  it('rebuilds the output timeline from persisted events', () => {
    const events: WorkflowRunEvent[] = [
      { type: 'node_start', node: 'research', step: 1 },
      {
        type: 'message',
        node: 'research',
        content: 'Completed research.',
        is_final: true,
      },
      { type: 'node_end', node: 'research', step: 1, duration_ms: 42 },
      {
        type: 'done',
        state: { global: {}, nodes: {}, workflow: {} },
        total_steps: 1,
      },
    ];

    const view = replayWorkflowRunView({ status: 'running' }, events, {
      mode: 'task',
      nodes: [node],
    });

    expect(view).toMatchObject({
      status: 'completed',
      totalSteps: 1,
      execution: [
        expect.objectContaining({
          nodeId: 'research',
          status: 'completed',
          messages: [{ role: 'assistant', content: 'Completed research.' }],
        }),
      ],
    });
  });

  it('ends a running node when its workflow is cancelled', () => {
    const view = replayWorkflowRunView(
      { status: 'running' },
      [
        { type: 'node_start', node: 'research', step: 1 },
        {
          type: 'custom',
          node: '',
          event_type: 'workflow.run_cancelled',
          data: {},
        },
      ],
      { mode: 'task', nodes: [node] },
    );

    expect(view).toMatchObject({
      status: 'cancelled',
      activeNodeId: undefined,
      error: undefined,
      execution: [expect.objectContaining({ status: 'cancelled' })],
    });
  });
});
