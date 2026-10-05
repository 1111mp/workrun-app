// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
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

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  requestHandler = undefined;
  sessionClosedHandler = undefined;
  vi.clearAllMocks();
});

describe('PythonUiRequestDialog', () => {
  it('queues concurrent forms from separate runs and removes cancelled sessions', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(PythonUiRequestDialog)));
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
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.click();
    });
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
    vi.mocked(respondToPythonUiRequest).mockRejectedValueOnce(
      new Error('write failed'),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(PythonUiRequestDialog)));
    await act(async () =>
      requestHandler?.({
        runId: 'a',
        requestId: 'one',
        title: 'Retry form',
        schema: { type: 'object' },
      }),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.click(),
    );
    expect(document.body.textContent).toContain('Retry form');
    expect(
      document.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(false);
  });
  it('keeps a follow-up confirmation request visible after submitting a form', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(PythonUiRequestDialog));
    });

    await act(async () => {
      requestHandler?.({
        runId: 'run-1',
        requestId: 'collect-request',
        kind: 'collect',
        title: 'Choose resolution',
        schema: { type: 'object' },
      });
    });

    const submit = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.type === 'submit');
    expect(submit).toBeDefined();

    await act(async () => {
      submit?.click();
    });

    expect(document.body.textContent).toContain('Confirm resolution');
  });
});
