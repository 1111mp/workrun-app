import { emit } from '@tauri-apps/api/event';
import { describe, expect, it, vi } from 'vitest';

import { mockTauriCommands } from '@/test/tauri';

import { onPythonUiRequest, respondToPythonUiRequest } from './python-ipc';

describe('Python UI requests through Tauri events', () => {
  it('filters unrelated messages, normalizes requests and unsubscribes', async () => {
    mockTauriCommands();
    const handler = vi.fn();
    const stop = await onPythonUiRequest(handler);
    await emit('ipc-message', { sessionId: 'run-1', message: { type: 'log' } });
    expect(handler).not.toHaveBeenCalled();

    const payload = {
      sessionId: 'run-1',
      message: { type: 'ui.request', id: 'request-1', title: 'Approval' },
    };
    await emit('ipc-message', payload);
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      runId: 'run-1',
      requestId: 'request-1',
      title: 'Approval',
      schema: null,
      uiSchema: {},
      description: null,
      submitLabel: null,
      cancelLabel: null,
    });
    stop();
    await emit('ipc-message', payload);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes approval data to the backend and propagates rejection', async () => {
    const calls = mockTauriCommands({
      python_ui_respond: () => {
        throw new Error('Request expired');
      },
    });
    await expect(
      respondToPythonUiRequest(
        { runId: 'run-1', requestId: 'request-1' },
        { approved: true },
      ),
    ).rejects.toThrow('Request expired');
    expect(calls).toHaveBeenCalledWith('python_ui_respond', {
      request: {
        runId: 'run-1',
        requestId: 'request-1',
        data: { approved: true },
      },
    });
  });
});
