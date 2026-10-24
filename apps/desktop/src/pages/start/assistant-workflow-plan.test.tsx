import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { expect, it, vi } from 'vitest';

import type { WorkflowPlan } from '@/services/assistant';

import { AssistantWorkflowPlan } from './assistant-workflow-plan';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const plan: WorkflowPlan = {
  id: 'plan',
  sessionId: 'session',
  version: 2,
  status: 'ready',
  dependencyIssues: [],
  document: {
    goal: 'Process the supplied records',
    summary: 'A reviewable approach',
    inputs: [{ name: 'Records', description: 'The supplied file' }],
    outputs: ['A checked report'],
    steps: [
      {
        title: 'Check the records',
        description: 'Validate inputs before processing',
        node_types: ['agent'],
        configuration_notes: 'Use the selected model profile',
        dependencies: [],
      },
    ],
    constraints: ['No external writes'],
    assumptions: ['UTF-8 input'],
    questions: [],
    acceptance_criteria: ['Report matches verified inputs'],
  },
};
function view(value: WorkflowPlan, busy = false) {
  const decide = vi.fn(),
    discuss = vi.fn();
  render(
    <MemoryRouter>
      <AssistantWorkflowPlan
        plan={value}
        busy={busy}
        onDecide={decide}
        onDiscuss={discuss}
      />
    </MemoryRouter>,
  );
  return { decide, discuss };
}
it('shows the user-facing proposal and expands configuration only on request', async () => {
  const user = userEvent.setup();
  const { discuss } = view(plan);
  expect(screen.getByText('A checked report')).toBeVisible();
  expect(screen.getByText('Check the records')).toBeVisible();
  expect(
    screen.queryByText('Use the selected model profile'),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole('button', { name: 'assistant.plan.details' }),
  );
  expect(screen.getByText('Use the selected model profile')).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: 'assistant.plan.discuss' }),
  );
  expect(discuss).toHaveBeenCalledOnce();
});
it('exposes distinct create and cancel choices without starting execution', async () => {
  const user = userEvent.setup();
  const { decide } = view(plan);
  await user.click(
    screen.getByRole('button', { name: 'assistant.plan.approve' }),
  );
  expect(decide).toHaveBeenLastCalledWith('approve');
  await user.click(
    screen.getByRole('button', { name: 'assistant.plan.cancel' }),
  );
  expect(decide).toHaveBeenLastCalledWith('cancel');
  expect(screen.getByText('assistant.plan.creationOnly')).toBeVisible();
});
it.each(['questions', 'dependencies', 'busy'] as const)(
  'blocks creation with %s',
  (reason) => {
    const current = {
      ...plan,
      document: {
        ...plan.document,
        questions: reason === 'questions' ? ['Which scope?'] : [],
      },
      dependencyIssues: reason === 'dependencies' ? ['Missing dependency'] : [],
    };
    view(current, reason === 'busy');
    expect(
      screen.getByRole('button', { name: 'assistant.plan.approve' }),
    ).toBeDisabled();
  },
);
it('shows the saved workflow link and removes proposal actions', () => {
  view({ ...plan, status: 'saved', workflowId: 'workflow-id' });
  expect(
    screen.getByRole('link', { name: 'assistant.plan.openWorkflow' }),
  ).toHaveAttribute('href', '/workflows/workflow-id');
  expect(
    screen.queryByRole('button', { name: 'assistant.plan.approve' }),
  ).not.toBeInTheDocument();
});

it('explicitly distinguishes a paused proposal from a created workflow', () => {
  view({
    ...plan,
    interaction: {
      id: 'plan:v2',
      taskId: 'plan',
      threadId: 'thread',
      checkpointId: 'checkpoint',
      kind: 'plan_confirmation',
      version: 2,
      status: 'waiting',
    },
  });
  expect(
    screen.getByText('assistant.plan.waitingFeedback'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('offers question-specific replies without approving the proposal', async () => {
  const user = userEvent.setup();
  const { decide, discuss } = view({
    ...plan,
    status: 'needs_clarification',
    document: {
      ...plan.document,
      questions: ['Which audience?', 'What is the scope?'],
    },
  });
  expect(screen.getByText('assistant.plan.clarificationHint')).toBeVisible();
  await user.click(
    screen.getAllByRole('button', {
      name: 'assistant.plan.answerQuestion',
    })[1]!,
  );
  expect(discuss).toHaveBeenCalledWith('What is the scope?');
  expect(decide).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'assistant.plan.approve' }),
  ).toBeDisabled();
});

it('shows acceptance criteria without opening technical configuration', () => {
  view(plan);
  expect(screen.getByText('Report matches verified inputs')).toBeVisible();
});

it('keeps historical questions readable without offering stale reply actions', () => {
  render(
    <MemoryRouter>
      <AssistantWorkflowPlan
        plan={{
          ...plan,
          document: { ...plan.document, questions: ['Which audience?'] },
        }}
        busy={false}
        active={false}
        onDiscuss={vi.fn()}
        onDecide={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('Which audience?')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'assistant.plan.answerQuestion' }),
  ).not.toBeInTheDocument();
});

it('folds a confirmed proposal and keeps the saved workflow accessible', async () => {
  const user = userEvent.setup();
  const renderPlan = (status: WorkflowPlan['status']) => (
    <MemoryRouter>
      <AssistantWorkflowPlan
        plan={{
          ...plan,
          status,
          workflowId: status === 'saved' ? 'workflow-id' : undefined,
        }}
        busy={status === 'building'}
        onDecide={vi.fn()}
        onDiscuss={vi.fn()}
      />
    </MemoryRouter>
  );
  const screenView = render(renderPlan('ready'));
  expect(screen.getByText('Check the records')).toBeVisible();
  screenView.rerender(renderPlan('building'));
  expect(screen.queryByText('Check the records')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'assistant.plan.approve' }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole('button', { name: 'assistant.plan.viewPlan' }),
  );
  expect(screen.getByText('Check the records')).toBeVisible();
  screenView.rerender(renderPlan('saved'));
  expect(
    screen.getByRole('link', { name: 'assistant.plan.openWorkflow' }),
  ).toBeVisible();
});

function Destination() {
  const location = useLocation();
  return <div data-testid='origin'>{location.state?.assistantReturnTo}</div>;
}
it.each(['saved', 'revision'] as const)(
  'preserves the source conversation for the %s workflow link',
  async (kind) => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/start?session=sales']}>
        <Routes>
          <Route
            path='/start'
            element={
              <AssistantWorkflowPlan
                plan={
                  kind === 'saved'
                    ? { ...plan, status: 'saved', workflowId: 'workflow-id' }
                    : {
                        ...plan,
                        document: {
                          ...plan.document,
                          target_id: 'workflow-id',
                        },
                      }
                }
                busy={false}
                onDecide={() => {}}
                onDiscuss={() => {}}
              />
            }
          />
          <Route path='/workflows/:id' element={<Destination />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(
      screen.getByRole('link', {
        name:
          kind === 'saved'
            ? 'assistant.plan.openWorkflow'
            : 'assistant.plan.revisionTarget',
      }),
    );
    expect(screen.getByTestId('origin')).toHaveTextContent(
      '/start?session=sales',
    );
  },
);

it('renders saved outcomes as Markdown', () => {
  view({
    ...plan,
    status: 'saved',
    outcome: {
      summary:
        '### 创建结果\n\n已保存，**未执行**。\n\n- 输入：`sales_csv`\n- 待验证：实际运行结果',
    },
  });
  const status = screen.getByRole('status');
  expect(status.querySelector('h3')).toHaveTextContent('创建结果');
  expect(status.querySelector('strong')).toHaveTextContent('未执行');
  expect(status.querySelector('code')).toHaveTextContent('sales_csv');
  expect(status.querySelectorAll('li')).toHaveLength(2);
});

it('keeps legacy plain-text outcomes readable', () => {
  view({
    ...plan,
    status: 'saved',
    outcome: { summary: '已保存工作流草稿。未运行任何节点。' },
  });
  expect(screen.getByRole('status')).toHaveTextContent(
    '已保存工作流草稿。未运行任何节点。',
  );
});

it('folds historical dense receipts and separates sentences without changing configuration text', async () => {
  const summary = `已保存工作流草稿 abc-123。结构：start → codeact_agent → agent → end。计算节点：通过 /artifacts/manifest.json 读取 sales.csv，settings.outputSchema 声明 report，state.globalKeys=["report"]，平均单价 12.50。${'配置约定保持完整，缺列时 status=blocked，数值字段置 null；'.repeat(12)}节点契约通过校验；未运行任何节点。`;
  const user = userEvent.setup();
  view({ ...plan, status: 'saved', outcome: { summary } });
  expect(screen.queryByTestId('plan-outcome-details')).not.toBeInTheDocument();
  await user.click(
    screen.getByRole('button', { name: 'assistant.plan.viewOutcome' }),
  );
  const details = screen.getByTestId('plan-outcome-details');
  expect(details.querySelectorAll('p').length).toBeGreaterThan(3);
  expect(details.textContent).toBe(summary);
  expect(details).toHaveTextContent('/artifacts/manifest.json');
  expect(details).toHaveTextContent('12.50');
  await user.click(
    screen.getByRole('button', { name: 'assistant.plan.hideOutcome' }),
  );
  expect(screen.queryByTestId('plan-outcome-details')).not.toBeInTheDocument();
});
