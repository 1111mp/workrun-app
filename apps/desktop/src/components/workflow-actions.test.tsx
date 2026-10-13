import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  render as renderComponent,
  type RenderResult,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { PendingAction } from '@/services/run-history';
import {
  resolveBackgroundWorkflowAction,
  validateWorkflowAction,
} from '@/services/workflow';

import { WorkflowActionCard } from './workflow-actions';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      values?: {
        answer?: string;
      },
    ) => (values?.answer ? `${key}: ${values.answer}` : key),
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
  validateWorkflowAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/components/artifact-files', () => ({ ArtifactFiles: () => null }));
afterEach(() => vi.clearAllMocks());

async function mount(action: PendingAction, prefetch = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (prefetch && action.status === 'pending') {
    await client.prefetchQuery({
      queryKey: ['run-history', 'action-readiness', 'personal', action.id],
      queryFn: async () => {
        await validateWorkflowAction(action.id);
        return true;
      },
    });
  }
  const host = document.createElement('div');
  document.body.append(host);
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  const render = async (value: PendingAction) =>
    act(
      async () =>
        (rendered = renderComponent(
          <QueryClientProvider client={client}>
            <WorkflowActionCard action={value} />
          </QueryClientProvider>,
          { container: host },
        )),
    );
  await render(action);
  return {
    host,
    render,
    close: async () => {
      rendered.unmount();
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
  const user = userEvent.setup();
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
    await user.click(button(view.host, 'approval.tool.run'));
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
  const user = userEvent.setup();
  const action = request('question-draft', 'ask_user_question', {
    title: 'Choose a destination',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  });
  const first = await mount(action);
  await user.click(
    first.host.querySelectorAll('input[type="radio"]')[1] as HTMLElement,
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
    await user.click(button(second.host, 'approval.continue'));
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
  const user = userEvent.setup();
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
    await user.click(button(view.host, 'approval.cards.details'));
    expect(view.host.textContent).toContain('Reviewed report');
    expect(resolveBackgroundWorkflowAction).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it('renders a resolved questionnaire with its saved answer disabled', async () => {
  const user = userEvent.setup();
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
    await user.click(button(view.host, 'approval.cards.details'));
    expect(view.host.querySelector('[data-slot="questionnaire"]')).toBeTruthy();
    const inputs = view.host.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    );
    expect(inputs[1].checked).toBe(true);
    expect(inputs[0].matches(':disabled')).toBe(true);
    await user.click(inputs[0]);
    expect(inputs[1].checked).toBe(true);
    expect(resolveBackgroundWorkflowAction).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it.each([null, undefined])(
  'allows supplying missing review text (%s) and submits it with approval',
  async (content) => {
    const user = userEvent.setup();
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
      await user.click(button(view.host, 'approval.review.approveContinue'));
      expect(resolveBackgroundWorkflowAction).toHaveBeenCalledWith(
        `review-empty-${String(content)}`,
        expect.any(String),
        {
          approved: true,
          edits: { input: 'Weather in Shanghai' },
        },
      );
      await user.click(button(view.host, 'approval.cards.details'));
      expect(view.host.textContent).toContain('Weather in Shanghai');
    } finally {
      await view.close();
    }
  },
);

it('keeps another request actionable while submission is in flight', async () => {
  const user = userEvent.setup();
  let complete!: () => void;
  vi.mocked(resolveBackgroundWorkflowAction)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce(undefined);
  const first = await mount(
    request('in-flight', 'tool_approval', { name: 'First' }),
  );
  const second = await mount(
    request('independent', 'tool_approval', { name: 'Second' }),
  );
  try {
    await user.click(button(first.host, 'approval.tool.run'));
    expect(button(first.host, 'approval.saving').disabled).toBe(true);
    expect(button(second.host, 'approval.tool.run').disabled).toBe(false);
    await user.click(button(second.host, 'approval.cards.denyTool'));
    expect(resolveBackgroundWorkflowAction).toHaveBeenLastCalledWith(
      'independent',
      expect.any(String),
      { approved: false },
    );
    expect(second.host.textContent).toContain('approval.cards.rejected');
    await act(async () => complete());
    expect(first.host.textContent).toContain('approval.cards.approved');
  } finally {
    await first.close();
    await second.close();
  }
});

it.each(['tool_approval', 'human_review', 'ask_user_question'] as const)(
  'makes an expired %s request read-only without submitting it',
  async (kind) => {
    const user = userEvent.setup();
    const action = request(`expired-${kind}`, kind, {
      content: 'Draft',
      contentKey: 'report',
      editable: true,
      options: [{ id: 'a', label: 'A' }],
    });
    const view = await mount(action);
    try {
      await view.render({ ...action, status: 'expired' });
      expect(view.host.textContent).toContain('approval.cards.expired');
      expect(view.host.querySelector('textarea')).toBeNull();
      expect(view.host.textContent).not.toContain(
        'approval.review.approveContinue',
      );
      expect(view.host.textContent).not.toContain('approval.tool.run');
      expect(view.host.textContent).not.toContain('approval.continue');
      await user.click(button(view.host, 'approval.cards.details'));
      expect(view.host.querySelector('textarea')).toBeNull();
      for (const input of view.host.querySelectorAll<HTMLInputElement>(
        'input',
      )) {
        expect(input.matches(':disabled')).toBe(true);
      }
      expect(resolveBackgroundWorkflowAction).not.toHaveBeenCalled();
    } finally {
      await view.close();
    }
  },
);

it('retains an unrestorable request and disables submission with its validation reason', async () => {
  const user = userEvent.setup();
  vi.mocked(validateWorkflowAction).mockRejectedValue(
    new Error('Saved checkpoint is missing'),
  );
  const view = await mount(
    request('missing-checkpoint', 'human_review', {
      contentKey: 'report',
      content: 'Original report',
      editable: true,
    }),
  );
  try {
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(view.host.textContent).toContain('Saved checkpoint is missing');
    });
    expect(view.host.textContent).toContain('executionRecovery.requestBlocked');
    expect(view.host.querySelector('textarea')?.value).toBe('Original report');
    expect(button(view.host, 'approval.review.approveContinue').disabled).toBe(
      true,
    );
    await user.click(button(view.host, 'approval.review.approveContinue'));
    expect(resolveBackgroundWorkflowAction).not.toHaveBeenCalled();
  } finally {
    await view.close();
    vi.mocked(validateWorkflowAction).mockResolvedValue(undefined);
  }
});

it('keeps request validation in the action area and enables actions when it finishes', async () => {
  let finish!: () => void;
  vi.mocked(validateWorkflowAction).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = await mount(
    request('checking-tool', 'tool_approval', {
      toolName: 'weather',
      args: { city: 'Hangzhou' },
    }),
    false,
  );
  try {
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain(
      'executionRecovery.checkingRequest',
    );
    expect(view.host.textContent).not.toContain(
      'executionRecovery.checkingDescription',
    );
    expect(button(view.host, 'approval.tool.run').disabled).toBe(true);
    await act(async () => finish());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(button(view.host, 'approval.tool.run').disabled).toBe(false);
    });
    expect(view.host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await view.close();
    vi.mocked(validateWorkflowAction).mockResolvedValue(undefined);
  }
});
