import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import type { AssistantToolConfirmation } from '@/services/assistant';

import { AssistantToolConfirmationCard } from './assistant-tool-confirmation';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const confirmation: AssistantToolConfirmation = {
  id: 'operation',
  turnId: 'turn',
  turnKey: 'key',
  tool: { id: 'mcp:server:tool', displayName: 'Selected tool' },
  arguments: { destination: 'chosen-location', count: 3 },
  interaction: {
    id: 'tool:operation',
    taskId: 'operation',
    threadId: 'thread',
    checkpointId: 'checkpoint',
    kind: 'tool_confirmation',
    version: 1,
    status: 'waiting',
  },
};
it('shows the exact tool and arguments and offers independent approve and deny feedback', async () => {
  const decide = vi.fn();
  render(
    <AssistantToolConfirmationCard
      confirmation={confirmation}
      active
      busy={false}
      onDecide={decide}
    />,
  );
  expect(screen.getByText('mcp:server:tool')).toBeVisible();
  expect(
    screen.getByLabelText('assistant.toolConfirmation.arguments'),
  ).toHaveTextContent('chosen-location');
  const user = userEvent.setup();
  await user.click(
    screen.getByRole('button', { name: 'assistant.toolConfirmation.approve' }),
  );
  expect(decide).toHaveBeenLastCalledWith('approve');
  await user.click(
    screen.getByRole('button', { name: 'assistant.toolConfirmation.deny' }),
  );
  expect(decide).toHaveBeenLastCalledWith('deny');
});
it('keeps historical requests readable without actionable authorization controls', () => {
  render(
    <AssistantToolConfirmationCard
      confirmation={confirmation}
      active={false}
      busy={false}
      onDecide={vi.fn()}
    />,
  );
  expect(screen.getByText('Selected tool')).toBeVisible();
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});
it('disables feedback after resume and while a turn is in progress', () => {
  render(
    <AssistantToolConfirmationCard
      confirmation={{
        ...confirmation,
        interaction: { ...confirmation.interaction, status: 'executing' },
      }}
      active
      busy
      onDecide={vi.fn()}
    />,
  );
  for (const button of screen.getAllByRole('button'))
    expect(button).toBeDisabled();
});
