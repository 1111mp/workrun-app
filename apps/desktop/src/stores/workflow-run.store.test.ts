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
  it('keeps errors on the failing invocation and resolves node names', () => {
    const parallel = { ...node, id: 'parallel', data: { name: 'Parallel' } };
    const run = workflowRunView(
      replayWorkflowRunProjection(
        'run-1',
        events(
          { type: 'node_start', node: 'research', step: 0 },
          { type: 'node_end', node: 'research', step: 0, duration_ms: 1 },
          { type: 'node_start', node: 'research', step: 1 },
          { type: 'node_start', node: 'parallel', step: 2 },
          {
            type: 'error',
            node: null,
            message: "Node 'research' execution failed: traceback",
          },
        ),
        { mode: 'task', nodes: [node, parallel] },
      ),
    );
    expect(run.execution[0].error).toBeUndefined();
    expect(run.execution[1]).toMatchObject({
      status: 'failed',
      error: "Node 'Research' execution failed: traceback",
    });
    expect(run.execution[2].error).toBeUndefined();
    expect(run.error).toBe("Node 'research' execution failed: traceback");
  });

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

describe('automatic Process App cleanup messages', () => {
  it('updates the matching invocation message without changing task failure or Agent response', () => {
    const run = workflowRunView(
      replayWorkflowRunProjection(
        'run-1',
        events(
          { type: 'node_start', node: 'research', step: 0 },
          {
            type: 'message',
            node: 'research',
            content: 'Original answer',
            is_final: true,
          },
          { type: 'node_end', node: 'research', step: 0, duration_ms: 5 },
          { type: 'node_start', node: 'research', step: 1 },
          {
            type: 'message',
            node: 'research',
            content: 'Later answer',
            is_final: true,
          },
          { type: 'node_end', node: 'research', step: 1, duration_ms: 5 },
          { type: 'error', node: 'later', message: 'Review failed' },
          {
            type: 'custom',
            node: 'research',
            event_type: 'process.compensation',
            data: {
              operationId: 'upload-1',
              ownerStep: 0,
              appName: 'Upload',
              entry: 'compensate.py',
              status: 'running',
              output: 'Removed uploaded file\n',
            },
          },
          {
            type: 'custom',
            node: 'research',
            event_type: 'process.compensation',
            data: {
              operationId: 'upload-1',
              ownerStep: 0,
              appName: 'Upload',
              entry: 'compensate.py',
              status: 'succeeded',
            },
          },
        ),
        { mode: 'task', nodes: [node] },
      ),
    );
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Review failed');
    expect(run.execution[0].status).toBe('completed');
    expect(run.execution[0].messages).toEqual([
      { role: 'assistant', content: 'Original answer' },
      expect.objectContaining({
        content: 'Compensation · Upload · compensate.py: succeeded',
        compensation: expect.objectContaining({
          operationId: 'upload-1',
          status: 'succeeded',
          output: 'Removed uploaded file\n',
        }),
      }),
    ]);
    expect(run.execution[1].messages).toEqual([
      { role: 'assistant', content: 'Later answer' },
    ]);
  });
});

describe('remote lifecycle messages', () => {
  it('updates the original invocation without replacing its answer or workflow error', () => {
    const run = workflowRunView(
      replayWorkflowRunProjection(
        'run-1',
        events(
          { type: 'node_start', node: 'research', step: 0 },
          {
            type: 'message',
            node: 'research',
            content: 'Original answer',
            is_final: true,
          },
          { type: 'node_end', node: 'research', step: 0, duration_ms: 1 },
          { type: 'node_start', node: 'research', step: 1 },
          { type: 'error', node: 'research', message: 'Original failure' },
          {
            type: 'custom',
            node: 'research',
            event_type: 'remote.lifecycle',
            data: {
              remoteRecordId: 'remote-1',
              ownerStep: 0,
              status: 'cancel_requested',
            },
          },
          {
            type: 'custom',
            node: 'research',
            event_type: 'remote.lifecycle',
            data: {
              remoteRecordId: 'remote-1',
              ownerStep: 0,
              status: 'canceled',
            },
          },
        ),
        { mode: 'task', nodes: [node] },
      ),
    );
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Original failure');
    expect(run.execution[0].messages).toEqual([
      { role: 'assistant', content: 'Original answer' },
      {
        role: 'assistant',
        content: 'Remote task: canceled',
        remoteLifecycle: {
          remoteRecordId: 'remote-1',
          ownerStep: 0,
          status: 'canceled',
        },
      },
    ]);
    expect(run.execution[1].messages ?? []).toEqual([]);
  });
});

it('replays waiting requests without exposing the checkpoint reason as an error', () => {
  const projection = replayWorkflowRunProjection(
    'run-1',
    events(
      { type: 'node_start', node: 'research', step: 0 },
      {
        type: 'custom',
        node: 'research',
        event_type: 'workflow.human_review_required',
        data: { runActionId: 'review-1' },
      },
      {
        type: 'interrupted',
        node: 'research',
        message: 'Internal checkpoint reason',
      },
    ),
    {
      mode: 'chat',
      nodes: [node],
      turnId: 'turn-1',
      input: { input: 'Review this' },
    },
  );
  expect(projection.status).toBe('interrupted');
  expect(projection.error).toBeUndefined();
  expect(projection.turnsById['turn-1'].runId).toBe('run-1');
  expect(projection.turnsById['turn-1'].error).toBeUndefined();
});

it('keeps review requests on their original invocation when a node runs again', () => {
  const projection = replayWorkflowRunProjection(
    'run-1',
    events(
      { type: 'node_start', node: 'research', step: 0 },
      {
        type: 'custom',
        node: 'research',
        event_type: 'workflow.human_review_required',
        data: { runActionId: 'review-1' },
      },
      { type: 'interrupted', node: 'research', message: 'Review required' },
      { type: 'resumed', step: 0, pending_nodes: ['research'] },
      { type: 'node_start', node: 'research', step: 0 },
      { type: 'node_end', node: 'research', step: 0, duration_ms: 1 },
      { type: 'node_start', node: 'research', step: 1 },
      {
        type: 'custom',
        node: 'research',
        event_type: 'workflow.human_review_required',
        data: { runActionId: 'review-2' },
      },
    ),
    { mode: 'task', nodes: [node] },
  );
  const execution = workflowRunView(projection).execution;
  expect(execution[0].actionIds).toEqual(['review-1']);
  expect(execution[1].actionIds).toEqual(['review-2']);
});

it('refreshes a restored run without reopening a panel the user closed', () => {
  const projection = replayWorkflowRunProjection('run-1', [], {
    mode: 'task',
    nodes: [node],
  });
  const store = useWorkflowRunStore.getState();
  store.restoreWorkflowRun(projection);
  expect(useWorkflowRunStore.getState().runPanelOpen).toBe(true);
  store.setRunPanelOpen(false);
  store.restoreWorkflowRun(projection, false);
  expect(useWorkflowRunStore.getState().runPanelOpen).toBe(false);
  store.restoreWorkflowRun(projection);
  expect(useWorkflowRunStore.getState().runPanelOpen).toBe(true);
});
