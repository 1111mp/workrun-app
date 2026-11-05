import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { MessageMarkdown } from './message-markdown';
import { WorkflowBackButton } from './workflow-editor/workflow-back-button';

vi.mock('@/hooks/use-highlighted-code', () => ({
  useHighlightedCode: (code: string) => code.split('\n'),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeTextFile: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('renders GFM tables, tasks, links and inline code', () => {
  const { container } = render(
    <MessageMarkdown
      content={
        '# Result\n\n| Name | Value |\n| --- | --- |\n| test | 1 |\n\n- [x] done\n\n~~removed~~ and `inline` [link](https://example.com)'
      }
    />,
  );
  expect(screen.getByRole('heading', { name: 'Result' })).toBeInTheDocument();
  expect(screen.getByRole('table')).toHaveTextContent('test');
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(container.querySelector('del')).toHaveTextContent('removed');
  expect(container.querySelector('code')).toHaveTextContent('inline');
  expect(screen.getByRole('link')).toHaveAttribute('rel', 'noreferrer');
});

it('renders unfinished and unlabelled code fences with copy controls', () => {
  const { container, rerender } = render(
    <MessageMarkdown content={'```python\nprint("hello")'} />,
  );
  expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  expect(container.querySelectorAll('pre')).toHaveLength(1);
  expect(container.querySelector('pre')).toHaveTextContent('print("hello")');
  rerender(<MessageMarkdown content={'```\nplain\n```'} />);
  expect(screen.getByText('text')).toBeInTheDocument();
  expect(container.querySelector('pre')).toHaveTextContent('plain');
});

it('renders formulas and does not execute model HTML', () => {
  const { container } = render(
    <MessageMarkdown
      content={
        '$x^2$\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)'
      }
    />,
  );
  expect(container.querySelector('.katex')).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull();
  expect(screen.getByText('bad')).not.toHaveAttribute(
    'href',
    expect.stringContaining('javascript:'),
  );
});

it('numbers code lines and toggles wrapping without changing the source', () => {
  const { container } = render(
    <MessageMarkdown content={'```js\nconst a = 1;\n\nconsole.log(a);\n```'} />,
  );
  const pre = container.querySelector('pre');
  expect(pre).toHaveAttribute('data-numbered', 'true');
  expect(
    container.querySelectorAll('[data-slot="code-block-line"]'),
  ).toHaveLength(3);
  const wrap = screen.getByRole('button', { name: 'codeBlock.wrap' });
  expect(wrap).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(wrap);
  expect(pre).toHaveAttribute('data-wrap', 'true');
  expect(wrap).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(wrap);
  expect(pre).not.toHaveAttribute('data-wrap');
});

it('downloads the original code through the desktop save dialog', async () => {
  vi.mocked(save).mockResolvedValue('/tmp/code.py');
  render(<MessageMarkdown content={'```python\nprint(1)\n```'} />);
  fireEvent.click(screen.getByRole('button', { name: 'codeBlock.download' }));
  await waitFor(() =>
    expect(writeTextFile).toHaveBeenCalledWith('/tmp/code.py', 'print(1)'),
  );
  expect(save).toHaveBeenCalledWith({ defaultPath: 'code.py' });
});

it('does not write a file when the save dialog is cancelled', async () => {
  vi.mocked(save).mockResolvedValue(null);
  render(<MessageMarkdown content={'```\nplain\n```'} />);
  const download = screen.getByRole('button', { name: 'codeBlock.download' });
  fireEvent.click(download);
  await waitFor(() => expect(download).not.toBeDisabled());
  expect(writeTextFile).not.toHaveBeenCalled();
});

it('opens scheduling action links in the Workrun router', async () => {
  render(
    <MemoryRouter initialEntries={['/schedules']}>
      <Routes>
        <Route
          path='/schedules'
          element={
            <MessageMarkdown content='该工作流包含需要人工回答的节点。[打开 Weather workflow](/workflows/weather)' />
          }
        />
        <Route path='/workflows/weather' element={<h1>Weather editor</h1>} />
      </Routes>
    </MemoryRouter>,
  );
  const link = screen.getByRole('link', { name: '打开 Weather workflow' });
  expect(link).not.toHaveAttribute('target');
  fireEvent.click(link);
  expect(
    await screen.findByRole('heading', { name: 'Weather editor' }),
  ).toBeInTheDocument();
});

function ScheduleOrigin() {
  const location = useLocation();
  return (
    <>
      <output data-testid='schedule-origin'>
        {location.pathname}
        {location.search}
        {location.hash}:{location.key}
      </output>
      <MessageMarkdown
        content={`[打开 Weather workflow](${window.location.origin}/workflows/weather)`}
      />
    </>
  );
}
it('returns an absolute same-origin workflow link to its original scheduled task conversation', async () => {
  render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: '/schedules',
          search: '?conversation=weather&task=once',
          hash: '#latest',
          key: 'original-schedule',
        },
      ]}
    >
      <Routes>
        <Route path='/schedules' element={<ScheduleOrigin />} />
        <Route path='/workflows/weather' element={<WorkflowBackButton />} />
      </Routes>
    </MemoryRouter>,
  );
  const link = screen.getByRole('link', { name: '打开 Weather workflow' });
  expect(link).not.toHaveAttribute('target');
  fireEvent.click(link);
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'workflowEditor.backToConversation',
    }),
  );
  expect(screen.getByTestId('schedule-origin')).toHaveTextContent(
    '/schedules?conversation=weather&task=once#latest:original-schedule',
  );
});
it('keeps an external workflow-shaped URL external', () => {
  render(
    <MemoryRouter>
      <MessageMarkdown content='[External](https://example.com/workflows/weather)' />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'External' })).toHaveAttribute(
    'target',
    '_blank',
  );
});
