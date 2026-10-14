import {
  act,
  render as renderComponent,
  type RenderResult,
} from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';

import type { RunSpan } from '@/services/run-history';
import type { WorkflowRunEventEnvelope } from '@/services/workflow';
import { useWorkflowRunStore } from '@/stores/workflow-run.store';

import recording from './__fixtures__/workflow-output-replay.json';
import { LiveWorkflowTaskOutput } from './workflow-output-panel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', async () => await import('@/stores/workflow-run.store'));
vi.mock('@/components/artifact-files', () => ({ ArtifactFiles: () => null }));
vi.mock('@/components/remote-tasks', () => ({ RemoteTasksPanel: () => null }));
vi.mock('@/components/workflow-chat-composer', () => ({
  WorkflowChatComposer: () => null,
}));
vi.mock('@/components/workflow-code-block', () => ({
  WorkflowCodeBlock: () => null,
}));
vi.mock('@/components/workflow-recovery-notice', () => ({
  WorkflowRecoveryNotice: () => null,
}));
vi.mock('@/components/workflow-actions', () => ({
  WorkflowActionCards: () => null,
  WorkflowActionNotice: () => null,
  useWorkflowActions: () => ({ data: [] }),
}));
vi.mock('@melloware/react-logviewer', () => ({ LazyLog: () => null }));
vi.mock('@workspace/ui/components', async () => {
  // DOM identity is tested independently of drawer positioning and scrolling
  // observers, which require a real layout engine rather than jsdom.
  const names = [
    'Alert',
    'AlertDescription',
    'AlertTitle',
    'Badge',
    'Bubble',
    'BubbleContent',
    'Button',
    'Collapsible',
    'CollapsibleContent',
    'CollapsibleTrigger',
    'DrawerDescription',
    'DrawerFooter',
    'DrawerHeader',
    'DrawerTitle',
    'Empty',
    'EmptyDescription',
    'EmptyHeader',
    'EmptyMedia',
    'EmptyTitle',
    'Marker',
    'MarkerContent',
    'MarkerIcon',
    'Message',
    'MessageContent',
    'MessageHeader',
    'MessageScroller',
    'MessageScrollerButton',
    'MessageScrollerContent',
    'MessageScrollerItem',
    'MessageScrollerProvider',
    'MessageScrollerViewport',
    'Spinner',
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      ({
        children,
        messageId,
        className,
      }: {
        children?: ReactNode;
        messageId?: string;
        className?: string;
      }) => (
        <div
          data-component={name}
          data-message-id={messageId}
          className={className}
        >
          {children}
        </div>
      ),
    ]),
  );
});

it('keeps completed messages and the viewport mounted through the recorded tool approval and resume sequence', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flushFrames = async () => {
    for (let i = 0; frames.size && i < 100; i++) {
      await act(async () => {
        const current = [...frames.values()];
        frames.clear();
        current.forEach((callback) => callback(i * 16));
      });
    }
    expect(frames.size).toBe(0);
  };
  const host = document.createElement('div');
  document.body.append(host);
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  const nodes = recording.nodes as Node[];
  useWorkflowRunStore.getState().startWorkflowRun('recorded-run', {}, 'task');
  const render = async (spans: RunSpan[] = []) =>
    act(
      async () =>
        (rendered = renderComponent(
          <LiveWorkflowTaskOutput
            workflowNodes={nodes}
            onRunAgain={vi.fn()}
            onClose={vi.fn()}
            spans={spans}
          />,
          { container: host },
        )),
    );
  try {
    await render();
    const viewport = host.querySelector(
      '[data-component="MessageScrollerViewport"]',
    );
    let firstRow: Element | null = null;
    let cancelThought: Element | undefined;
    for (const envelope of recording.events as WorkflowRunEventEnvelope[]) {
      await act(async () =>
        useWorkflowRunStore
          .getState()
          .applyRunEvents([envelope], { mode: 'task', nodes }),
      );
      await flushFrames();
      if (envelope.sequence === 6)
        firstRow = host.querySelector(
          '[data-message-id="recorded-run:execution:2"]',
        );
      if (envelope.sequence >= 6) {
        expect(firstRow).toBeTruthy();
        expect(
          host.querySelector('[data-message-id="recorded-run:execution:2"]'),
        ).toBe(firstRow);
        expect(firstRow!.textContent).toContain(
          'Recorded response at event 4.',
        );
      }
      expect(
        host.querySelector('[data-component="MessageScrollerViewport"]'),
      ).toBe(viewport);
      const thoughts = host.querySelectorAll(
        '[data-message-id="live-thinking"] [data-component="Marker"]',
      );
      if (envelope.sequence === 18) cancelThought = Array.from(thoughts).at(-1);
      if (envelope.sequence >= 18) {
        expect(cancelThought).toBeTruthy();
        expect(Array.from(thoughts).at(-1)).toBe(cancelThought);
      }
      // Model telemetry refreshes independently of streamed output.
      if (
        envelope.event.type === 'custom' &&
        envelope.event.event_type === 'agent.model_call'
      ) {
        await render([
          {
            id: `model-${envelope.sequence}`,
            kind: 'model_call',
            status: 'completed',
            nodeId: envelope.event.node,
            totalTokens: 10,
            totalTokensEstimated: false,
          } as RunSpan,
        ]);
        expect(
          host.querySelector('[data-component="MessageScrollerViewport"]'),
        ).toBe(viewport);
      }
    }
    expect(useWorkflowRunStore.getState().projection.executionIds).toHaveLength(
      4,
    );
    expect(host.textContent).toContain('Recorded response at event 31.');
    expect(
      host.querySelectorAll('[data-message-id="recorded-run:execution:18"]'),
    ).toHaveLength(1);
  } finally {
    rendered.unmount();
    vi.unstubAllGlobals();
    host.remove();
  }
});

it('shows restored task output immediately without scheduling typing frames', async () => {
  const requestFrame = vi.fn();
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  const nodes = recording.nodes as Node[];
  const store = useWorkflowRunStore.getState();
  store.startWorkflowRun('recorded-run', {}, 'task');
  store.applyRunEvents(recording.events as WorkflowRunEventEnvelope[], {
    mode: 'task',
    nodes,
  });
  const host = document.createElement('div');
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  try {
    rendered = renderComponent(
      <LiveWorkflowTaskOutput
        workflowNodes={nodes}
        onRunAgain={vi.fn()}
        onClose={vi.fn()}
      />,
      { container: host },
    );
    expect(host.textContent).toContain('Recorded response at event 31.');
    expect(host.textContent).not.toContain('workflowEditor.output.running');
    expect(requestFrame).not.toHaveBeenCalled();
  } finally {
    rendered.unmount();
    vi.unstubAllGlobals();
  }
});

it('renders Agent chunks in the Web panel while the node is still running', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const host = document.createElement('div');
  document.body.append(host);
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  const nodes: Node[] = [
    {
      id: 'agent',
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { name: 'Agent' },
    },
  ];
  const store = useWorkflowRunStore.getState();
  store.resetRunView();
  store.startWorkflowRun('stream-run', {}, 'task');
  let sequence = 0;
  const deliver = async (event: WorkflowRunEventEnvelope['event']) => {
    await act(async () =>
      store.applyRunEvents(
        [{ runId: 'stream-run', sequence: sequence++, event }],
        { mode: 'task', nodes },
      ),
    );
    for (let i = 0; frames.size && i < 100; i++) {
      await act(async () => {
        const current = [...frames.values()];
        frames.clear();
        current.forEach((callback) => callback(i * 16));
      });
    }
  };
  try {
    rendered = renderComponent(
      <LiveWorkflowTaskOutput
        workflowNodes={nodes}
        onRunAgain={vi.fn()}
        onClose={vi.fn()}
      />,
      { container: host },
    );
    await deliver({ type: 'node_start', node: 'agent', step: 0 });
    await deliver({
      type: 'message',
      node: 'agent',
      content: 'First live chunk',
      is_final: false,
    });
    expect(host.textContent).toContain('First live chunk');
    expect(
      useWorkflowRunStore.getState().projection.executionsById[
        'stream-run:execution:0'
      ]?.status,
    ).toBe('running');
    await deliver({
      type: 'message',
      node: 'agent',
      content: ' and second chunk',
      is_final: false,
    });
    expect(host.textContent).toContain('First live chunk and second chunk');
    expect(
      useWorkflowRunStore.getState().projection.executionsById[
        'stream-run:execution:0'
      ]?.status,
    ).toBe('running');
    await deliver({
      type: 'message',
      node: 'agent',
      content: '',
      is_final: true,
    });
    await deliver({
      type: 'node_end',
      node: 'agent',
      step: 0,
      duration_ms: 100,
    });
    const row = host.querySelector(
      '[data-message-id="stream-run:execution:0"]',
    );
    expect(
      row?.textContent?.match(/First live chunk and second chunk/g),
    ).toHaveLength(1);
  } finally {
    rendered.unmount();
    store.resetRunView();
    vi.unstubAllGlobals();
    host.remove();
  }
});
