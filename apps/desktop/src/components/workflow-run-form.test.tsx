import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { WorkflowRunForm } from './workflow-run-panel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', () => ({ useWorkflowRunStore: vi.fn() }));
vi.mock('@/components/workflow-output-panel', () => ({
  LiveWorkflowTaskOutput: () => null,
  WorkflowRunOutput: () => null,
}));
vi.mock('@/components/artifact-files', () => ({ ArtifactFiles: () => null }));

it('submits the entered optional input rather than an empty initial state', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const settings = {
    mode: 'task',
    inputSchema: {
      fields: [
        {
          id: 'input-field',
          key: 'input',
          label: 'Input',
          type: 'textarea',
          required: false,
        },
      ],
    },
  } as unknown as WorkflowSettings;
  render(
    <WorkflowRunForm
      settings={settings}
      isRunning={false}
      onClose={vi.fn()}
      onRun={onRun}
    />,
  );
  await user.type(
    screen.getByRole('textbox', { name: 'Input' }),
    '查询上海天气',
  );
  await user.click(screen.getByRole('button', { name: 'workflows.run' }));
  expect(onRun).toHaveBeenCalledWith({ input: '查询上海天气' });
});
