import { act, render as renderComponent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
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
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(inputs = [field], disabled = false) {
  const onSend = vi.fn();
  function Harness() {
    const [values, setValues] = useState<Record<string, unknown>>({
      documents: [files[0]],
    });
    return (
      <WorkflowChatComposer
        fileInputs={inputs}
        filesForInput={(key) => values[key]}
        message='Analyze'
        onMessageChange={vi.fn()}
        disabled={disabled}
        onFileChange={(key, value) =>
          setValues((current) => ({ ...current, [key]: value }))
        }
        onSubmit={(event) => {
          event.preventDefault();
          onSend(values);
        }}
      />
    );
  }
  const { container } = renderComponent(<Harness />);
  return { container, onSend };
}

async function pick(label: string) {
  const user = userEvent.setup();
  await user.click(
    document.querySelector<HTMLButtonElement>(
      '[aria-label="workflowEditor.artifacts.add"]',
    )!,
  );
  const item = await screen.findByRole('menuitem', { name: label });
  await user.click(item!);
}

async function send(container: HTMLElement) {
  const user = userEvent.setup();
  await user.click(
    container.querySelector<HTMLButtonElement>('[type="submit"]')!,
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
  const user = userEvent.setup();
  vi.mocked(pickArtifacts).mockResolvedValue([]);
  const { container, onSend } = await render();
  await pick('workflowEditor.artifacts.add');
  expect(container.textContent).toContain('old.pdf');
  await user.click(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="workflowEditor.artifacts.remove"]',
    )!,
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

it('focuses the message when clicking the composer background', async () => {
  const { container } = await render([]);
  const user = userEvent.setup();
  await user.click(container.querySelector('[data-slot="input-group"]')!);
  expect(screen.getByRole('textbox')).toHaveFocus();
});

it('keeps the draft editable while responding and stops only when the stop button is clicked', async () => {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  function Harness({ responding = true, stopping = false }) {
    const [message, setMessage] = useState('');
    return (
      <WorkflowChatComposer
        fileInputs={[]}
        filesForInput={() => []}
        onFileChange={vi.fn()}
        message={message}
        onMessageChange={setMessage}
        disabled={false}
        responding={responding}
        stopping={stopping}
        onStop={onStop}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(message);
        }}
      />
    );
  }
  const user = userEvent.setup();
  const view = renderComponent(<Harness />);
  const textbox = screen.getByRole('textbox');
  expect(textbox).toBeEnabled();
  await user.type(textbox, 'Next question{Enter}');
  expect(textbox).toHaveValue('Next question');
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onStop).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'assistant.stop' }));
  expect(onStop).toHaveBeenCalledOnce();
  view.rerender(<Harness stopping />);
  expect(screen.getByRole('button', { name: 'assistant.stop' })).toBeDisabled();
  expect(textbox).toBeEnabled();
  view.rerender(<Harness responding={false} />);
  await user.click(
    screen.getByRole('button', { name: 'workflowEditor.output.send' }),
  );
  expect(onSubmit).toHaveBeenCalledWith('Next question');
});
