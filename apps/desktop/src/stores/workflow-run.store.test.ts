import type { Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import type { WorkflowRunEventEnvelope } from '@/services/workflow';

import {
  replayWorkflowRunProjection,
  useWorkflowRunStore,
  workflowRunView,
} from './workflow-run.store';

const node: Node = {
  id: 'research',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { name: 'Research' },
};

function events(
  ...event: WorkflowRunEventEnvelope['event'][]
): WorkflowRunEventEnvelope[] {
  return event.map((item, index) => ({
    runId: 'run-1',
    sequence: index,
    event: item,
  }));
}

describe('workflow run projection', () => {
  it('replays persisted envelopes into the same task output model', () => {
    const projection = replayWorkflowRunProjection(
      'run-1',
      events(
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
      ),
      { mode: 'task', nodes: [node] },
    );

    expect(workflowRunView(projection)).toMatchObject({
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

  it('uses sequence-based IDs and preserves completed entity identity', () => {
    const store = useWorkflowRunStore.getState();
    store.startWorkflowRun('run-1', {}, 'task');
    store.applyRunEvents(
      events(
        { type: 'node_start', node: 'research', step: 1 },
        { type: 'node_end', node: 'research', step: 1, duration_ms: 42 },
      ),
      { mode: 'task', nodes: [node] },
    );
    const firstId = useWorkflowRunStore.getState().projection.executionIds[0];
    const completed =
      useWorkflowRunStore.getState().projection.executionsById[firstId];

    store.applyRunEvents(
      events(
        { type: 'node_start', node: 'write', step: 2 },
        {
          type: 'message',
          node: 'write',
          content: 'Drafting.',
          is_final: true,
        },
      ).map((envelope) => ({ ...envelope, sequence: envelope.sequence + 2 })),
      {
        mode: 'task',
        nodes: [node, { ...node, id: 'write', data: { name: 'Write' } }],
      },
    );

    const projection = useWorkflowRunStore.getState().projection;
    expect(firstId).toBe('run-1:execution:0');
    expect(projection.executionsById[firstId]).toBe(completed);
    expect(projection.executionIds).toHaveLength(2);
  });

  it('does not end thinking when an agent tool result arrives', () => {
    const store = useWorkflowRunStore.getState();
    store.startWorkflowRun('run-1', {}, 'task');
    store.applyRunEvents(
      events(
        { type: 'node_start', node: 'research', step: 1 },
        {
          type: 'custom',
          node: 'research',
          event_type: 'agent.tool_result',
          data: { tool: 'search' },
        },
      ),
      { mode: 'task', nodes: [node] },
    );
    const thoughtId =
      useWorkflowRunStore.getState().projection.latestThoughtIdByNode.research;
    expect(
      useWorkflowRunStore.getState().projection.thoughtsById[thoughtId]?.status,
    ).toBe('running');

    store.applyRunEvents(
      events({
        type: 'node_end',
        node: 'research',
        step: 1,
        duration_ms: 5,
      }).map((envelope) => ({ ...envelope, sequence: 3 })),
      { mode: 'task', nodes: [node] },
    );
    expect(
      useWorkflowRunStore.getState().projection.thoughtsById[thoughtId]?.status,
    ).toBe('completed');
  });

  it('treats a tool confirmation interrupt as awaiting input, not an error', () => {
    const store = useWorkflowRunStore.getState();
    store.startWorkflowRun('run-1', {}, 'task');
    store.applyRunEvents(
      events(
        {
          type: 'custom',
          node: 'research',
          event_type: 'agent.tool_approval_required',
          data: { functionCallId: 'call-1', fingerprint: 'fingerprint' },
        },
        {
          type: 'interrupted',
          node: 'research',
          message: 'Dynamic interrupt: tool_confirmation',
        },
      ),
      { mode: 'task', nodes: [node] },
    );

    expect(useWorkflowRunStore.getState().projection).toMatchObject({
      status: 'interrupted',
      error: undefined,
    });
    expect(useWorkflowRunStore.getState().toolApproval).toMatchObject({
      functionCallId: 'call-1',
    });
  });

  it('retains the failed execution when continuing the same task', () => {
    const projection = replayWorkflowRunProjection(
      'run-1',
      events(
        { type: 'node_start', node: 'research', step: 1 },
        { type: 'error', node: 'research', message: 'temporary failure' },
        {
          type: 'custom',
          node: '',
          event_type: 'workflow.attempt_started',
          data: {},
        },
        { type: 'resumed', step: 1, pending_nodes: ['research'] },
        { type: 'node_start', node: 'research', step: 1 },
        { type: 'node_end', node: 'research', step: 1, duration_ms: 20 },
        {
          type: 'done',
          state: { global: {}, nodes: {}, workflow: {} },
          total_steps: 2,
        },
      ),
      { mode: 'task', nodes: [node] },
    );
    expect(projection.runId).toBe('run-1');
    expect(projection.executionIds).toHaveLength(2);
    expect(projection.executionsById[projection.executionIds[0]].status).toBe(
      'failed',
    );
    expect(projection.executionsById[projection.executionIds[1]].status).toBe(
      'completed',
    );
    expect(projection.status).toBe('completed');
    expect(projection.error).toBeUndefined();
  });

  it('merges an action-resumed node into its original logical execution', () => {
    const projection = replayWorkflowRunProjection(
      'run-1',
      events(
        { type: 'node_start', node: 'research', step: 1 },
        { type: 'node_end', node: 'research', step: 1, duration_ms: 10 },
        {
          type: 'interrupted',
          node: 'research',
          message: 'Dynamic interrupt: tool_confirmation',
        },
        { type: 'resumed', step: 1, pending_nodes: ['research'] },
        { type: 'node_start', node: 'research', step: 1 },
        { type: 'node_end', node: 'research', step: 1, duration_ms: 20 },
      ),
      { mode: 'chat', nodes: [node] },
    );

    expect(projection.executionIds).toHaveLength(1);
    expect(projection.thoughtIds).toHaveLength(1);
    expect(workflowRunView(projection).execution[0]).toMatchObject({
      nodeId: 'research',
      status: 'completed',
      durationMs: 20,
    });
  });

  it('keeps chat node responses on their execution instead of appending bubbles', () => {
    const store = useWorkflowRunStore.getState();
    store.startWorkflowRun(
      'run-1',
      { input: 'Research this.' },
      'chat',
      'turn-1',
    );
    store.applyRunEvents(
      events(
        { type: 'node_start', node: 'research', step: 1 },
        {
          type: 'message',
          node: 'research',
          content: 'Research complete.',
          is_final: true,
        },
      ),
      { mode: 'chat', nodes: [node], turnId: 'turn-1' },
    );

    const projection = useWorkflowRunStore.getState().projection;
    expect(projection.messageIds).toHaveLength(1);
    expect(projection.executionsById['run-1:execution:0']?.messages).toEqual([
      { role: 'assistant', content: 'Research complete.' },
    ]);
  });

  it('appends a second chat turn while resetting its run-local event cursor', () => {
    const store = useWorkflowRunStore.getState();
    store.resetRunView();
    store.startWorkflowRun(
      'run-1',
      { input: 'First question' },
      'chat',
      'turn-1',
    );
    store.applyRunEvents(
      events({
        type: 'done',
        state: { global: {}, nodes: {}, workflow: {} },
        total_steps: 1,
      }),
      { mode: 'chat', nodes: [node], turnId: 'turn-1' },
    );

    store.startWorkflowRun(
      'run-2',
      { input: 'Second question' },
      'chat',
      'turn-2',
    );
    store.applyRunEvents(
      [
        {
          runId: 'run-2',
          sequence: 0,
          event: { type: 'node_start', node: 'research', step: 1 },
        },
      ],
      { mode: 'chat', nodes: [node], turnId: 'turn-2' },
    );

    const projection = useWorkflowRunStore.getState().projection;
    expect(
      workflowRunView(projection).messages.map((message) => message.content),
    ).toEqual(['First question', 'Second question']);
    expect(projection.eventSequence).toBe(0);
    expect(projection.executionsById['run-2:execution:0']?.turnId).toBe(
      'turn-2',
    );
    expect(workflowRunView(projection).turnsById).toMatchObject({
      'turn-1': { status: 'completed', totalSteps: 1 },
      'turn-2': { status: 'running' },
    });
  });

  it('retains the selected chat session across an editor remount', () => {
    const store = useWorkflowRunStore.getState();
    store.setActiveChatSession({
      workflowId: 'workflow-1',
      sessionId: 'session-1',
    });

    expect(useWorkflowRunStore.getState().activeChatSession).toEqual({
      workflowId: 'workflow-1',
      sessionId: 'session-1',
    });
  });

  it('restores the user turn needed to display historical chat output', () => {
    const projection = replayWorkflowRunProjection(
      'run-1',
      events(
        { type: 'node_start', node: 'research', step: 1 },
        {
          type: 'message',
          node: 'research',
          content: 'Research complete.',
          is_final: true,
        },
      ),
      {
        mode: 'chat',
        nodes: [node],
        input: { input: 'Research this.' },
        turnId: 'history:run-1',
      },
    );

    expect(workflowRunView(projection)).toMatchObject({
      messages: [
        {
          role: 'user',
          content: 'Research this.',
          turnId: 'history:run-1',
        },
      ],
      execution: [
        {
          turnId: 'history:run-1',
          messages: [{ role: 'assistant', content: 'Research complete.' }],
        },
      ],
      turnsById: { 'history:run-1': { status: 'running' } },
    });
  });

  it('keeps the user turn when a historical chat run fails before producing output', () => {
    const projection = replayWorkflowRunProjection(
      'run-1',
      events(
        { type: 'node_start', node: 'research', step: 1 },
        {
          type: 'error',
          node: 'research',
          message: 'model.rate_limited',
        },
      ),
      {
        mode: 'chat',
        nodes: [node],
        input: { input: 'Cancel order 43' },
        turnId: 'history:run-1',
      },
    );

    expect(workflowRunView(projection)).toMatchObject({
      status: 'failed',
      error: 'model.rate_limited',
      messages: [expect.objectContaining({ content: 'Cancel order 43' })],
      turnsById: {
        'history:run-1': {
          status: 'failed',
          error: 'model.rate_limited',
        },
      },
    });
  });
});
