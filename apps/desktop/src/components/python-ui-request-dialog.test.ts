// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let requestHandler: ((request: any) => void) | undefined;

vi.mock('@/services/python-ipc', () => ({
  onPythonUiRequest: vi.fn(async (handler) => {
    requestHandler = handler;
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

import { PythonUiRequestDialog } from './python-ui-request-dialog';

let container: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  requestHandler = undefined;
});

describe('PythonUiRequestDialog', () => {
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

    const submit = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.type === 'submit');
    expect(submit).toBeDefined();

    await act(async () => {
      submit?.click();
    });

    expect(document.body.textContent).toContain('Confirm resolution');
  });
});
