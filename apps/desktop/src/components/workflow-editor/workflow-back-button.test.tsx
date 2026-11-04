import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { expect, it, vi } from 'vitest';

import { WorkflowBackButton } from './workflow-back-button';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
function Destination() {
  const location = useLocation();
  return (
    <div data-testid='destination'>
      {location.pathname}
      {location.search}:{location.key}
    </div>
  );
}
it.each(['/start?session=sales', '/schedules?conversation=weather&task=once'])(
  'returns to the original conversation history entry %s',
  async (origin) => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: origin.split('?')[0],
            search: '?' + origin.split('?')[1],
            key: 'original-conversation',
          },
          {
            pathname: '/workflows/report',
            state: { assistantReturnTo: origin },
          },
        ]}
      >
        <Routes>
          <Route path='/start' element={<Destination />} />
          <Route path='/schedules' element={<Destination />} />
          <Route path='/workflows/:id' element={<WorkflowBackButton />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'workflowEditor.backToConversation' }),
    );
    expect(screen.getByTestId('destination')).toHaveTextContent(
      `${origin}:original-conversation`,
    );
  },
);
it('returns direct workflow entries to the workflow list', async () => {
  render(
    <MemoryRouter initialEntries={['/workflows/report']}>
      <Routes>
        <Route path='/workflows' element={<Destination />} />
        <Route path='/workflows/:id' element={<WorkflowBackButton />} />
      </Routes>
    </MemoryRouter>,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'workflowEditor.backToWorkflows' }),
  );
  expect(screen.getByTestId('destination')).toHaveTextContent('/workflows:');
});
