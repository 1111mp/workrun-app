import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import type { AssistantWorkflowConfirmation } from '@/services/assistant';

import { AssistantWorkflowConfirmationCard } from './assistant-workflow-confirmation';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const confirmation: AssistantWorkflowConfirmation = {
  id: 'confirmation',
  turnId: 'turn',
  workflowId: 'workflow',
  name: 'Document summary',
  description: 'Summarize supplied documents.',
  input: { document: 'selected-file', limit: 0 },
  status: 'waiting',
  changed: false,
};
it('shows the chosen workflow and inputs and waits for execution or selection feedback', async () => {
  const decide = vi.fn().mockResolvedValue(undefined);
  render(
    <AssistantWorkflowConfirmationCard
      confirmation={confirmation}
      active
      busy={false}
      onDecide={decide}
    />,
  );
  expect(screen.getByText('Document summary')).toBeVisible();
  expect(decide).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(screen.getByText('assistant.runConfirmation.inputs'));
  expect(screen.getByText(/selected-file/)).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: 'assistant.runConfirmation.approve' }),
  );
  expect(decide).toHaveBeenLastCalledWith('approve');
  await user.click(
    screen.getByRole('button', { name: 'assistant.runConfirmation.reselect' }),
  );
  expect(decide).toHaveBeenLastCalledWith('reselect');
  await user.click(
    screen.getByRole('button', { name: 'assistant.runConfirmation.cancel' }),
  );
  expect(decide).toHaveBeenLastCalledWith('cancel');
});
it('prevents duplicate feedback while a decision is pending', async () => {
  let resolve!: () => void;
  const decide = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  render(
    <AssistantWorkflowConfirmationCard
      confirmation={confirmation}
      active
      busy={false}
      onDecide={decide}
    />,
  );
  const user = userEvent.setup();
  await user.dblClick(
    screen.getByRole('button', { name: 'assistant.runConfirmation.approve' }),
  );
  expect(decide).toHaveBeenCalledOnce();
  for (const button of screen.getAllByRole('button'))
    expect(button).toBeDisabled();
  resolve();
});
it('retains historical decisions without live controls and explains changed snapshots', () => {
  const { rerender } = render(
    <AssistantWorkflowConfirmationCard
      confirmation={{ ...confirmation, status: 'cancelled' }}
      active={false}
      busy={false}
      onDecide={vi.fn()}
    />,
  );
  expect(screen.queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByText('assistant.runConfirmation.cancelled')).toBeVisible();
  expect(
    screen.getByText('assistant.runConfirmation.cancelledDescription'),
  ).toBeVisible();
  rerender(
    <AssistantWorkflowConfirmationCard
      confirmation={{ ...confirmation, changed: true }}
      active
      busy
      onDecide={vi.fn()}
    />,
  );
  expect(screen.getByText('assistant.runConfirmation.changed')).toBeVisible();
  for (const button of screen.getAllByRole('button'))
    expect(button).toBeDisabled();
});
it('keeps failed feedback retryable', async () => {
  const decide = vi
    .fn()
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValue(undefined);
  render(
    <AssistantWorkflowConfirmationCard
      confirmation={confirmation}
      active
      busy={false}
      onDecide={decide}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole('button', { name: 'assistant.runConfirmation.reselect' }),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Connection lost');
  await user.click(
    screen.getByRole('button', { name: 'assistant.runConfirmation.reselect' }),
  );
  expect(decide).toHaveBeenCalledTimes(2);
});
