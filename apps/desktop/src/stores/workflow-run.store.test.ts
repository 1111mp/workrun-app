import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { WorkflowRunEvent } from '@/services/workflow';

import { replayWorkflowRunView } from './workflow-run.store';

const node: Node = {
  id: 'research',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { name: 'Research' },
};

describe('replayWorkflowRunView', () => {
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
      { type: 'done', state: { workflow: {} }, total_steps: 1 },
    ];

    const view = replayWorkflowRunView(
      { status: 'running' },
      events,
      { mode: 'task', nodes: [node] },
    );

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
});
