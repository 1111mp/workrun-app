// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';

import {
  listRemoteTasks,
  listRemoteTaskWarnings,
  manageRemoteTask,
  type RemoteTask,
} from '@/services/remote-agent';
import { inspectRunRecord } from '@/services/run-history';

import {
  RemoteTaskRerunButton,
  RemoteTasksPanel,
  RemoteTaskStartWarning,
} from './remote-tasks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/remote-agent', () => ({
  listRemoteTasks: vi.fn(),
  listRemoteTaskWarnings: vi.fn(),
  manageRemoteTask: vi.fn(),
  remoteTaskMayRepeat: (task: RemoteTask, failed: boolean) =>
    [
      'unknown',
      'working',
      'submitted',
      'input_required',
      'auth_required',
    ].includes(task.status) ||
    (task.status === 'completed' && (failed || !task.result)),
}));
vi.mock('@/services/run-history', () => ({ inspectRunRecord: vi.fn() }));
const openRun = vi.hoisted(() => vi.fn());
vi.mock('@/stores/run-workspace.store', () => ({
  useRunWorkspaceStore: { getState: () => ({ openRun }) },
}));
vi.mock('@/components/artifact-files', () => ({
  ArtifactFiles: ({ value }: { value: unknown }) =>
    createElement('pre', null, JSON.stringify(value)),
}));

const task: RemoteTask = {
  id: 'record-1',
  runId: 'run-1',
  nodeId: 'remote',
  messageId: 'message-1',
  serviceOrigin: 'https://agent.example',
  taskId: 'task-1',
  status: 'unknown',
  lastKnownState: 'TASK_STATE_WORKING',
  createdAt: '2026-10-05T00:00:00Z',
  updatedAt: '2026-10-05T00:00:01Z',
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function render(element: ReactElement) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await settle();
  cleanups.push(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  return container;
}
async function click(key: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('button'),
  ].find(
    (item) =>
      item.textContent === key || item.textContent?.startsWith(`${key} ·`),
  );
  expect(button).toBeDefined();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
  await settle();
}

it('queries and collects a remote result without invoking workflow execution', async () => {
  let current = { ...task };
  vi.mocked(listRemoteTasks).mockImplementation(async () => [current]);
  vi.mocked(manageRemoteTask).mockImplementation(async (_id, operation) => {
    current = {
      ...current,
      status: 'completed',
      ...(operation === 'fetch'
        ? {
            result: {
              response: 'finished remotely',
              artifacts: [
                {
                  $type: 'artifact',
                  id: 'pdf',
                  version: 1,
                  name: 'result.pdf',
                  mimeType: 'application/pdf',
                  size: 12,
                },
              ],
            },
          }
        : {}),
    };
    return current;
  });
  const container = await render(
    createElement(RemoteTasksPanel, {
      runId: 'run-1',
      isActive: false,
      nodeName: () => 'PDF agent',
    }),
  );
  expect(container.textContent).toContain('task-1');
  expect(container.textContent).toContain(
    'workflowEditor.remoteTasks.unknownTitle',
  );
  await click('workflowEditor.remoteTasks.query');
  expect(manageRemoteTask).toHaveBeenLastCalledWith('record-1', 'query');
  await click('workflowEditor.remoteTasks.fetch');
  expect(manageRemoteTask).toHaveBeenLastCalledWith('record-1', 'fetch');
  expect(container.textContent).toContain('result.pdf');
  const fetch = [
    ...container.querySelectorAll<HTMLButtonElement>('button'),
  ].find((button) => button.textContent === 'workflowEditor.remoteTasks.fetch');
  expect(fetch!.disabled).toBe(true);
});

it('requires confirmation to cancel and never claims success after refusal', async () => {
  vi.mocked(listRemoteTasks).mockResolvedValue([task]);
  vi.mocked(manageRemoteTask).mockRejectedValue('Task not cancelable');
  const container = await render(
    createElement(RemoteTasksPanel, {
      runId: 'run-1',
      isActive: false,
      nodeName: (id) => id,
    }),
  );
  await click('workflowEditor.remoteTasks.cancel');
  expect(manageRemoteTask).not.toHaveBeenCalled();
  const confirm = document.querySelector<HTMLButtonElement>(
    '[data-slot="alert-dialog-action"]',
  );
  expect(confirm).not.toBeNull();
  await act(async () => confirm!.click());
  await settle();
  expect(manageRemoteTask).toHaveBeenCalledWith('record-1', 'cancel');
  expect(container.textContent).toContain(
    'workflowEditor.remoteTasks.status.unknown',
  );
  expect(container.textContent).not.toContain(
    'workflowEditor.remoteTasks.status.canceled',
  );
});

it('disables remote operations while the local workflow owns execution', async () => {
  vi.mocked(listRemoteTasks).mockResolvedValue([
    { ...task, status: 'completed' },
  ]);
  const container = await render(
    createElement(RemoteTasksPanel, {
      runId: 'run-1',
      isActive: true,
      nodeName: (id) => id,
    }),
  );
  const toggle = [
    ...container.querySelectorAll<HTMLButtonElement>('button'),
  ].find((button) => button.textContent === 'workflowEditor.remoteTasks.title');
  await act(async () => toggle!.click());
  await settle();
  for (const key of ['query', 'fetch', 'cancel']) {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((item) => item.textContent === `workflowEditor.remoteTasks.${key}`);
    expect(button!.disabled).toBe(true);
  }
  expect(manageRemoteTask).not.toHaveBeenCalled();
});

it('warns before repeating unresolved remote work and only reruns on confirmation', async () => {
  vi.mocked(listRemoteTasks).mockResolvedValue([task]);
  const onRunAgain = vi.fn();
  await render(
    createElement(RemoteTaskRerunButton, {
      runId: 'run-1',
      disabled: false,
      onRunAgain,
      label: 'Run again',
    }),
  );
  await click('Run again');
  expect(listRemoteTasks).toHaveBeenCalledWith('run-1');
  expect(onRunAgain).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    'workflowEditor.remoteTasks.rerunTitle',
  );
  await click('workflowEditor.remoteTasks.rerunConfirm');
  expect(onRunAgain).toHaveBeenCalledTimes(1);
});

it('runs directly when prior remote work is confirmed cancelled', async () => {
  vi.mocked(listRemoteTasks).mockResolvedValue([
    { ...task, status: 'canceled' },
  ]);
  const onRunAgain = vi.fn();
  await render(
    createElement(RemoteTaskRerunButton, {
      runId: 'run-1',
      disabled: false,
      onRunAgain,
      label: 'Run again',
    }),
  );
  await click('Run again');
  expect(onRunAgain).toHaveBeenCalledTimes(1);
});

it('links warnings after restart to the original run instead of starting new work', async () => {
  vi.mocked(listRemoteTaskWarnings).mockResolvedValue([task]);
  const record = {
    id: 'run-1',
    targetType: 'workflow',
    targetId: 'workflow-1',
    targetName: 'PDF workflow',
    status: 'failed',
    startedAt: task.createdAt,
  };
  vi.mocked(inspectRunRecord).mockResolvedValue(
    record as Awaited<ReturnType<typeof inspectRunRecord>>,
  );
  const onReview = vi.fn();
  await render(
    createElement(RemoteTaskStartWarning, {
      workflowId: 'workflow-1',
      onReview,
    }),
  );
  expect(listRemoteTaskWarnings).toHaveBeenCalledWith('workflow-1');
  await click('workflowEditor.remoteTasks.review');
  expect(inspectRunRecord).toHaveBeenCalledWith('run-1');
  expect(openRun).toHaveBeenCalledWith(record);
  expect(onReview).toHaveBeenCalledTimes(1);
});

it('shows and copies the exact message ID for an unknown submission without enabling remote actions', async () => {
  vi.mocked(listRemoteTasks).mockResolvedValue([{ ...task, taskId: null }]);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const container = await render(
    createElement(RemoteTasksPanel, {
      runId: 'run-1',
      isActive: false,
      nodeName: (id) => id,
    }),
  );
  expect(container.textContent).toContain(
    'workflowEditor.remoteTasks.messageId',
  );
  expect(container.textContent).toContain('message-1');
  await click('workflowEditor.remoteTasks.copyMessageId');
  expect(writeText).toHaveBeenCalledExactlyOnceWith('message-1');
  expect(toast.success).toHaveBeenCalledWith(
    'workflowEditor.remoteTasks.messageIdCopied',
    { toasterId: 'global' },
  );
  for (const key of ['query', 'fetch', 'cancel']) {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((item) => item.textContent === `workflowEditor.remoteTasks.${key}`);
    expect(button!.disabled).toBe(true);
  }
  expect(manageRemoteTask).not.toHaveBeenCalled();
});

it('reports clipboard failures without claiming the message ID was copied', async () => {
  vi.mocked(listRemoteTasks).mockResolvedValue([{ ...task, taskId: null }]);
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
  });
  await render(
    createElement(RemoteTasksPanel, {
      runId: 'run-1',
      isActive: false,
      nodeName: (id) => id,
    }),
  );
  await click('workflowEditor.remoteTasks.copyMessageId');
  expect(toast.error).toHaveBeenCalledWith(
    'workflowEditor.remoteTasks.messageIdCopyFailed',
    { toasterId: 'global' },
  );
  expect(toast.success).not.toHaveBeenCalled();
});
