// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { PendingAction } from '@/services/run-history';
import { resolveBackgroundWorkflowAction } from '@/services/workflow';

import { WorkflowActionCard } from './workflow-actions';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { answer?: string }) =>
      values?.answer ? `${key}: ${values.answer}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
  useRunWorkspaceStore: Object.assign(() => undefined, {
    getState: () => ({ requestAction: vi.fn() }),
  }),
}));
vi.mock('@/services/workflow', () => ({
  resolveBackgroundWorkflowAction: vi.fn(),
}));
vi.mock('@/components/artifact-files', () => ({ ArtifactFiles: () => null }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

async function mount(action: PendingAction) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (value: PendingAction) =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(WorkflowActionCard, { action: value }),
        ),
      ),
    );
  await render(action);
  return {
    host,
    render,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
function button(host: HTMLElement, text: string) {
  const element = Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  );
  expect(element).toBeTruthy();
  return element!;
}
function request(
  id: string,
  kind: PendingAction['kind'],
  payload: unknown,
): PendingAction {
  return {
    id,
    runId: 'run-1',
    kind,
    payload,
    status: 'pending',
    createdAt: '2026-10-11T00:00:00Z',
  };
}

it('submits the selected tool request once, keeps errors retryable, and retains its result', async () => {
  const resolve = vi.mocked(resolveBackgroundWorkflowAction);
  resolve
    .mockRejectedValueOnce(new Error('Temporary failure'))
    .mockResolvedValueOnce(undefined);
  const view = await mount(
    request('tool-2', 'tool_approval', {
      name: 'Send report',
      input: { recipient: 'reviewer' },
    }),
  );
  try {
    expect(view.host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button(view.host, 'approval.tool.run').click());
    expect(view.host.textContent).toContain('Temporary failure');
    expect(resolve).toHaveBeenLastCalledWith('tool-2', expect.any(String), {
      approved: true,
    });
    await act(async () => {
      const approve = button(view.host, 'approval.tool.run');
      approve.click();
      approve.click();
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(view.host.textContent).toContain('approval.cards.approved');
    expect(view.host.textContent).not.toContain('approval.tool.run');
  } finally {
    await view.close();
  }
});

it('preserves an unanswered selection when its panel unmounts and requires explicit submission', async () => {
  const action = request('question-draft', 'ask_user_question', {
    title: 'Choose a destination',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  });
  const first = await mount(action);
  await act(async () =>
    (
      first.host.querySelectorAll('input[type="radio"]')[1] as HTMLElement
    ).click(),
  );
  expect(resolveBackgroundWorkflowAction).not.toHaveBeenCalled();
  await first.close();
  const second = await mount(action);
  try {
    expect(
      (
        second.host.querySelectorAll(
          'input[type="radio"]',
        )[1] as HTMLInputElement
      ).checked,
    ).toBe(true);
    await act(async () => button(second.host, 'approval.continue').click());
    expect(resolveBackgroundWorkflowAction).toHaveBeenCalledWith(
      'question-draft',
      expect.any(String),
      { optionId: 'b' },
    );
  } finally {
    await second.close();
  }
});

it('invalidates a stale card after cancellation and displays saved review edits in history', async () => {
  const action = request('review-1', 'human_review', {
    contentKey: 'report',
    editable: true,
    content: 'Original',
  });
  const view = await mount(action);
  try {
    await view.render({ ...action, status: 'cancelled' });
    expect(view.host.textContent).toContain('approval.cards.cancelled');
    expect(view.host.querySelector('textarea')).toBeNull();
    expect(view.host.textContent).not.toContain(
      'approval.review.approveContinue',
    );
    await view.render({
      ...action,
      status: 'resolved',
      resolution: { approved: true, edits: { report: 'Reviewed report' } },
    });
    await act(async () => button(view.host, 'approval.cards.details').click());
    expect(view.host.textContent).toContain('Reviewed report');
    expect(resolveBackgroundWorkflowAction).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it('renders a resolved questionnaire with its saved answer disabled', async () => {
  const view = await mount({
    ...request('question-resolved', 'ask_user_question', {
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', description: 'Second option' },
      ],
    }),
    status: 'resolved',
    resolution: { optionId: 'b' },
  });
  try {
    await act(async () => button(view.host, 'approval.cards.details').click());
    expect(view.host.querySelector('[data-slot="questionnaire"]')).toBeTruthy();
    const inputs = view.host.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    );
    expect(inputs[1].checked).toBe(true);
    expect(inputs[0].matches(':disabled')).toBe(true);
    await act(async () => inputs[0].click());
    expect(inputs[1].checked).toBe(true);
    expect(resolveBackgroundWorkflowAction).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it.each([null, undefined])(
  'allows supplying missing review text (%s) and submits it with approval',
  async (content) => {
    const view = await mount(
      request(`review-empty-${String(content)}`, 'human_review', {
        contentKey: 'input',
        editable: true,
        content,
        context: { input: null },
      }),
    );
    try {
      const textarea = view.host.querySelector('textarea');
      expect(textarea).toBeTruthy();
      expect(textarea!.value).toBe('');
      await act(async () => {
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!;
        descriptor.set!.call(textarea, 'Weather in Shanghai');
        textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () =>
        button(view.host, 'approval.review.approveContinue').click(),
      );
      expect(resolveBackgroundWorkflowAction).toHaveBeenCalledWith(
        `review-empty-${String(content)}`,
        expect.any(String),
        {
          approved: true,
          edits: { input: 'Weather in Shanghai' },
        },
      );
      await act(async () =>
        button(view.host, 'approval.cards.details').click(),
      );
      expect(view.host.textContent).toContain('Weather in Shanghai');
    } finally {
      await view.close();
    }
  },
);
