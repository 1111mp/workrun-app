import { act, render as renderComponent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

let requestHandler: ((request: any) => void) | undefined;
let sessionClosedHandler: ((sessionId: string) => void) | undefined;
vi.mock('@/services/python-ipc', () => ({
  onPythonUiRequest: vi.fn(async (handler) => {
    requestHandler = handler;
    return () => undefined;
  }),
  onPythonIpcSessionClosed: vi.fn(async (handler) => {
    sessionClosedHandler = handler;
    return () => undefined;
  }),
  respondToPythonUiRequest: vi.fn(async () => {
    requestHandler?.({
      runId: 'run-1',
      requestId: 'confirm-request',
      kind: 'confirm',
      title: 'Confirm resolution',
      schema: { type: 'object' },
    });
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { respondToPythonUiRequest } from '@/services/python-ipc';

import { PythonUiRequestDialog } from './python-ui-request-dialog';
afterEach(() => {
  requestHandler = undefined;
  sessionClosedHandler = undefined;
  vi.clearAllMocks();
});

describe('PythonUiRequestDialog', () => {
  it('queues concurrent forms from separate runs and removes cancelled sessions', async () => {
    const user = userEvent.setup();
    renderComponent(<PythonUiRequestDialog />);
    await act(async () => {
      requestHandler?.({
        runId: 'a',
        requestId: 'one',
        title: 'First form',
        schema: { type: 'object' },
      });
      requestHandler?.({
        runId: 'b',
        requestId: 'two',
        title: 'Second form',
        schema: { type: 'object' },
      });
      requestHandler?.({
        runId: 'c',
        requestId: 'three',
        title: 'Third form',
        schema: { type: 'object' },
      });
    });
    expect(document.body.textContent).toContain('First form');
    expect(document.body.textContent).not.toContain('Second form');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(respondToPythonUiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'a', requestId: 'one' }),
      {},
    );
    expect(document.body.textContent).toContain('Second form');
    await act(async () => sessionClosedHandler?.('b'));
    expect(document.body.textContent).toContain('Third form');
    expect(document.body.textContent).not.toContain('Second form');
  });
  it('retains a form after a failed response so it can be retried', async () => {
    const user = userEvent.setup();
    vi.mocked(respondToPythonUiRequest).mockRejectedValueOnce(
      new Error('write failed'),
    );
    renderComponent(<PythonUiRequestDialog />);
    await act(async () =>
      requestHandler?.({
        runId: 'a',
        requestId: 'one',
        title: 'Retry form',
        schema: { type: 'object' },
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(document.body.textContent).toContain('Retry form');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });
  it('keeps a follow-up confirmation request visible after submitting a form', async () => {
    const user = userEvent.setup();
    renderComponent(<PythonUiRequestDialog />);
    await act(async () => {
      requestHandler?.({
        runId: 'run-1',
        requestId: 'collect-request',
        kind: 'collect',
        title: 'Choose resolution',
        schema: { type: 'object' },
      });
    });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(document.body.textContent).toContain('Confirm resolution');
  });
});
