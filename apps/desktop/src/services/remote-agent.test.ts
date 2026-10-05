import { invoke } from '@tauri-apps/api/core';
import { expect, it, vi } from 'vitest';

import {
  listRemoteTasks,
  listRemoteTaskWarnings,
  manageRemoteTask,
  remoteTaskMayRepeat,
  type RemoteTask,
} from './remote-agent';
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
it('uses independent task commands without workflow submission or resume', async () => {
  await listRemoteTasks('run');
  expect(invoke).toHaveBeenLastCalledWith('remote_tasks_list', {
    runId: 'run',
  });
  await listRemoteTaskWarnings('workflow');
  expect(invoke).toHaveBeenLastCalledWith('remote_task_warnings', {
    workflowId: 'workflow',
  });
  await manageRemoteTask('record', 'fetch');
  expect(invoke).toHaveBeenLastCalledWith('remote_task_manage', {
    id: 'record',
    operation: 'fetch',
  });
});
it('treats completed remote work from failed local runs as repeatable work', () => {
  const completed = {
    status: 'completed',
    result: { response: 'done', artifacts: [] },
  } as unknown as RemoteTask;
  expect(remoteTaskMayRepeat(completed)).toBe(false);
  expect(remoteTaskMayRepeat(completed, true)).toBe(true);
  expect(remoteTaskMayRepeat({ status: 'unknown' } as RemoteTask)).toBe(true);
  expect(remoteTaskMayRepeat({ status: 'canceled' } as RemoteTask)).toBe(false);
});
