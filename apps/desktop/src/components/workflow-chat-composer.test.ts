// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import {
  artifactReferences,
  pickArtifacts,
  type ArtifactRef,
} from '@/services/artifact';

import { WorkflowChatComposer } from './workflow-chat-composer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/artifact', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/artifact')>()),
  pickArtifacts: vi.fn(),
}));
const files: ArtifactRef[] = ['old', 'new'].map((id) => ({
  $type: 'artifact',
  id,
  version: 1,
  name: `${id}.pdf`,
  mimeType: 'application/pdf',
  size: 1234,
}));
const field: WorkflowInput = {
  id: 'documents',
  key: 'documents',
  label: 'Documents',
  type: 'files',
  required: true,
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function render(inputs = [field], disabled = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const onSend = vi.fn();
  function Harness() {
    const [values, setValues] = useState<Record<string, unknown>>({
      documents: [files[0]],
    });
    return createElement(WorkflowChatComposer, {
      fileInputs: inputs,
      filesForInput: (key) => values[key],
      message: 'Analyze',
      onMessageChange: vi.fn(),
      disabled,
      onFileChange: (key, value) =>
        setValues((current) => ({ ...current, [key]: value })),
      onSubmit: (event) => {
        event.preventDefault();
        onSend(values);
      },
    });
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onSend };
}
async function pick(label: string) {
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="workflowEditor.artifacts.add"]',
      )!
      .click(),
  );
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === label);
  expect(item).toBeDefined();
  await act(async () => item!.click());
}
async function send(container: HTMLElement) {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[type="submit"]')!.click(),
  );
}
it('adds files through the menu, deduplicates selections, and preserves field routing', async () => {
  vi.mocked(pickArtifacts).mockResolvedValue(files);
  const { container, onSend } = await render();
  expect(container.querySelectorAll('[data-slot="attachment"]')).toHaveLength(
    1,
  );
  await pick('workflowEditor.artifacts.add');
  expect(pickArtifacts).toHaveBeenCalledWith(true);
  expect(container.querySelectorAll('[data-slot="attachment"]')).toHaveLength(
    2,
  );
  await send(container);
  expect(artifactReferences(onSend.mock.calls[0]![0].documents)).toEqual(files);
});
it('canceling the picker leaves selected files intact and removing them updates the submitted state', async () => {
  vi.mocked(pickArtifacts).mockResolvedValue([]);
  const { container, onSend } = await render();
  await pick('workflowEditor.artifacts.add');
  expect(container.textContent).toContain('old.pdf');
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="workflowEditor.artifacts.remove"]',
      )!
      .click(),
  );
  expect(container.querySelector('[data-slot="attachment"]')).toBeNull();
  await send(container);
  expect(onSend.mock.calls[0]![0].documents).toEqual([]);
});
it('routes a single-file selection to the chosen field without replacing other attachments', async () => {
  vi.mocked(pickArtifacts).mockResolvedValue([files[1]!]);
  const { container, onSend } = await render([
    field,
    { ...field, id: 'cover', key: 'cover', label: 'Cover', type: 'file' },
  ]);
  await pick('Cover');
  expect(pickArtifacts).toHaveBeenCalledWith(false);
  await send(container);
  expect(onSend.mock.calls[0]![0]).toEqual({
    documents: [files[0]],
    cover: files[1],
  });
});
it('blocks sending during file import and disables read-only attachment controls', async () => {
  let resolve!: (files: ArtifactRef[]) => void;
  vi.mocked(pickArtifacts).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { container, onSend } = await render();
  await pick('workflowEditor.artifacts.add');
  await send(container);
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => resolve([]));
  await send(container);
  expect(onSend).toHaveBeenCalledOnce();
  const readonly = await render([field], true);
  expect(
    readonly.container.querySelector<HTMLButtonElement>(
      '[aria-label="workflowEditor.artifacts.add"]',
    )!.disabled,
  ).toBe(true);
  expect(
    readonly.container.querySelector<HTMLButtonElement>(
      '[aria-label="workflowEditor.artifacts.remove"]',
    )!.disabled,
  ).toBe(true);
});
it('omits the file menu for workflows without file inputs and keeps IME Enter from submitting', async () => {
  const { container, onSend } = await render([]);
  expect(
    container.querySelector('[aria-label="workflowEditor.artifacts.add"]'),
  ).toBeNull();
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        isComposing: true,
      }),
    );
  });
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        shiftKey: true,
      }),
    );
  });
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
  expect(onSend).toHaveBeenCalledOnce();
});
