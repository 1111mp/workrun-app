// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  createElement,
  useEffect,
  useState,
  type ReactElement,
} from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';

import {
  listRemoteTasks,
  manageRemoteTask,
  type RemoteTask,
} from '@/services/remote-agent';

import { RemoteTasksPanel } from './remote-tasks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/remote-agent', () => ({
  listRemoteTasks: vi.fn(),
  manageRemoteTask: vi.fn(),
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

it('shows saved status and results without remote management actions', async () => {
  vi.mocked(listRemoteTasks).mockResolvedValue([
    {
      ...task,
      status: 'completed',
      result: { response: 'finished remotely', artifacts: [] },
    },
  ]);
  const container = await render(
    createElement(RemoteTasksPanel, {
      runId: 'run-1',
      isActive: false,
      nodeName: () => 'PDF agent',
    }),
  );
  expect(container.textContent).toContain('finished remotely');
  expect(container.textContent).toContain('PDF agent');
  expect(container.textContent).toContain(
    'workflowEditor.remoteTasks.status.completed',
  );
  for (const key of ['query', 'fetch', 'cancel', 'review']) {
    expect(container.textContent).not.toContain(
      `workflowEditor.remoteTasks.${key}`,
    );
  }
  expect(manageRemoteTask).not.toHaveBeenCalled();
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
    expect(button).toBeUndefined();
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

it('keeps remote task output mounted while a run resumes and its refresh fails', async () => {
  vi.mocked(listRemoteTasks).mockResolvedValue([
    {
      ...task,
      status: 'completed',
      result: { response: 'saved output', artifacts: [] },
    },
  ]);
  let resume!: () => void;
  function Harness() {
    const [active, setActive] = useState(false);
    useEffect(() => {
      resume = () => setActive(true);
    }, []);
    return createElement(RemoteTasksPanel, {
      runId: 'run-1',
      isActive: active,
      nodeName: () => 'Agent',
    });
  }
  const container = await render(createElement(Harness));
  const trigger = container.querySelector('button');
  expect(container.textContent).toContain('saved output');
  let reject!: (error: Error) => void;
  vi.mocked(listRemoteTasks).mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await act(async () => resume());
  await settle();
  expect(container.querySelector('button')).toBe(trigger);
  expect(container.textContent).toContain('saved output');
  await act(async () => reject(new Error('temporary read failure')));
  await settle();
  expect(container.querySelector('button')).toBe(trigger);
  expect(container.textContent).toContain('saved output');
});
