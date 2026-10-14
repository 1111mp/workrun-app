import {
  act,
  render as renderComponent,
  type RenderResult,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', async () => import('@/stores/workflow-run.store'));
vi.mock('@/components/workflow-output-panel', () => ({
  LiveWorkflowTaskOutput: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>Close output</button>
  ),
  WorkflowRunOutput: () => null,
}));
const ipc = vi.hoisted(() => ({
  request: undefined as ((request: unknown) => void) | undefined,
}));
vi.mock('@/services/python-ipc', () => ({
  onPythonUiRequest: async (handler: (request: unknown) => void) => {
    ipc.request = handler;
    return () => {};
  },
  onPythonIpcSessionClosed: async () => () => {},
  respondToPythonUiRequest: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { useWorkflowRunStore } from '@/stores/workflow-run.store';

import { PythonUiRequestDialog } from './python-ui-request-dialog';
import { WorkflowRunPanel } from './workflow-run-panel';

it('keeps workflow output open while a Process App form takes focus and is submitted', async () => {
  const user = userEvent.setup();
  const host = document.createElement('div');
  document.body.append(host);
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  const store = useWorkflowRunStore.getState();
  store.startWorkflowRun('workflow-run', {}, 'task');
  store.setShowRunOutput(true);
  store.setRunPanelOpen(true);
  try {
    rendered = renderComponent(
      <div>
        <button data-test='outside-output'>Canvas action</button>
        <WorkflowRunPanel
          settings={
            {
              mode: 'task',
              inputSchema: { fields: [] },
            } as unknown as WorkflowSettings
          }
          nodes={[]}
          onRun={vi.fn()}
          onResume={vi.fn()}
        />
        <PythonUiRequestDialog />
      </div>,
      { container: host },
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-slot="drawer-content"] button',
        )!
        .focus();
      ipc.request?.({
        runId: 'app-session',
        requestId: 'form',
        title: 'Process App form',
        schema: {
          type: 'object',
          properties: { name: { type: 'string', title: 'Name' } },
        },
      });
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-slot="alert-dialog-content"]'),
      ).not.toBeNull(),
    );
    await act(async () =>
      document
        .querySelector<HTMLInputElement>(
          '[data-slot="alert-dialog-content"] input',
        )!
        .focus(),
    );
    expect(useWorkflowRunStore.getState().runPanelOpen).toBe(true);
    await user.click(
      document.querySelector<HTMLButtonElement>(
        '[data-slot="alert-dialog-content"] button[type="submit"]',
      )!,
    );
    expect(useWorkflowRunStore.getState().runPanelOpen).toBe(true);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-slot="drawer-content"] button',
        )!
        .focus();
      const outside = host.querySelector<HTMLButtonElement>(
        '[data-test="outside-output"]',
      )!;
      outside.focus();
      outside.click();
    });
    await vi.waitFor(() =>
      expect(useWorkflowRunStore.getState().runPanelOpen).toBe(false),
    );
    await act(async () => store.setRunPanelOpen(true));
    await user.click(
      document.querySelector<HTMLButtonElement>(
        '[data-slot="drawer-content"] button',
      )!,
    );
    expect(useWorkflowRunStore.getState().runPanelOpen).toBe(false);
  } finally {
    rendered.unmount();
    store.resetRunView();
    store.setShowRunOutput(false);
    store.setRunPanelOpen(false);
    ipc.request = undefined;
    host.remove();
  }
});
