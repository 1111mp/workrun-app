import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { MessageMarkdown } from './message-markdown';

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
