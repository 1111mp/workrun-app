// @vitest-environment jsdom
import type { Node } from '@xyflow/react';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
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
vi.mock('@/components/workflow-actions', () => ({
  WorkflowActionCards: () => null,
  WorkflowActionNotice: () => null,
  useWorkflowActions: () => ({ data: [] }),
}));
vi.mock('@melloware/react-logviewer', () => ({ LazyLog: () => null }));
vi.mock('@workspace/ui/components', async () => {
  const { createElement } = await import('react');
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
      }) =>
        createElement(
          'div',
          { 'data-component': name, 'data-message-id': messageId, className },
          children,
        ),
    ]),
  );
});
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  const root = createRoot(host);
  const nodes = recording.nodes as Node[];
  useWorkflowRunStore.getState().startWorkflowRun('recorded-run', {}, 'task');
  const render = async (spans: RunSpan[] = []) =>
    act(async () =>
      root.render(
        createElement(LiveWorkflowTaskOutput, {
          workflowNodes: nodes,
          onRunAgain: vi.fn(),
          onClose: vi.fn(),
          spans,
        }),
      ),
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
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    host.remove();
  }
});
