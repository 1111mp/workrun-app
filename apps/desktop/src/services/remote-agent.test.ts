import { invoke } from '@tauri-apps/api/core';
import { expect, it, vi } from 'vitest';

import {
  listRemoteTasks,
  listRemoteTaskWarnings,
  manageRemoteTask,
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
