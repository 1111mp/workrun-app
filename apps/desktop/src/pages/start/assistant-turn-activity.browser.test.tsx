import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { AssistantTurnActivity } from './assistant-turn-activity';

it('shows the latest public summary and expands the bounded activity history', async () => {
  const screen = await render(
    <AssistantTurnActivity
      summaries={[
        'Check the available capabilities',
        'Validate the selected workflow inputs',
      ]}
      busy
    />,
  );
  const toggle = page.getByRole('button', { expanded: true });
  await expect
    .element(
      page
        .getByRole('region')
        .getByText('Validate the selected workflow inputs', {
          exact: true,
        }),
    )
    .toBeVisible();
  await toggle.click();
  await expect.element(page.getByRole('region')).not.toBeInTheDocument();
  await page.getByRole('button', { expanded: false }).click();
  await expect
    .element(
      page
        .getByRole('region')
        .getByText('Check the available capabilities', { exact: true }),
    )
    .toBeVisible();
  await screen.rerender(
    <AssistantTurnActivity
      summaries={[
        'Check the available capabilities',
        'Validate the selected workflow inputs',
        'Execution finished',
      ]}
      busy={false}
    />,
  );
  await expect.element(page.getByRole('button')).not.toBeInTheDocument();
  await expect.element(page.getByRole('region')).not.toBeInTheDocument();
});

it('updates the live summary even when a previous summary repeats', async () => {
  await render(
    <AssistantTurnActivity
      summaries={['Searching', 'Validating', 'Searching']}
      busy
    />,
  );
  await expect
    .element(
      page.getByRole('region').getByText('Searching', { exact: true }).last(),
    )
    .toBeVisible();
});
