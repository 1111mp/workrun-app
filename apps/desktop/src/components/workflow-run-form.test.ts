// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { WorkflowRunForm } from './workflow-run-panel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', () => ({ useWorkflowRunStore: vi.fn() }));
vi.mock('@/components/workflow-output-panel', () => ({
  LiveWorkflowTaskOutput: () => null,
  WorkflowRunOutput: () => null,
}));
vi.mock('@/components/artifact-files', () => ({ ArtifactFiles: () => null }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it('submits the entered optional input rather than an empty initial state', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onRun = vi.fn();
  const settings = {
    mode: 'task',
    inputSchema: {
      fields: [
        {
          id: 'input-field',
          key: 'input',
          label: 'Input',
          type: 'textarea',
          required: false,
        },
      ],
    },
  } as unknown as WorkflowSettings;
  try {
    await act(async () =>
      root.render(
        createElement(WorkflowRunForm, {
          settings,
          isRunning: false,
          onClose: vi.fn(),
          onRun,
        }),
      ),
    );
    const textarea = host.querySelector('textarea')!;
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!;
      descriptor.set!.call(textarea, '查询上海天气');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      host
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(onRun).toHaveBeenCalledWith({ input: '查询上海天气' });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
