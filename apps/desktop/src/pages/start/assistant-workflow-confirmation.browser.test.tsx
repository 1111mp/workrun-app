import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import zh from '@/locales/zh_CN.json';

import { AssistantWorkflowConfirmationCard } from './assistant-workflow-confirmation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          zh,
        ) as string,
  }),
}));
it('keeps the execution review readable at desktop and mobile widths', async () => {
  const decide = vi.fn().mockResolvedValue(undefined);
  const screen = await render(
    <main style={{ padding: 24, maxWidth: 840, margin: '0 auto' }}>
      <AssistantWorkflowConfirmationCard
        confirmation={{
          id: 'confirm',
          turnId: 'turn',
          workflowId: 'workflow',
          name: '文档整理与分析',
          description: '读取本次提供的资料，整理内容并生成报告。',
          input: { file: 'document.pdf', format: 'Markdown' },
          status: 'waiting',
          changed: false,
        }}
        active
        busy={false}
        onDecide={decide}
      />
    </main>,
  );
  for (const theme of ['light', 'dark']) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    for (const width of [1280, 390]) {
      await page.viewport(width, 900);
      await expect.element(screen.getByText('文档整理与分析')).toBeVisible();
      await expect
        .element(screen.getByRole('button', { name: '确认执行' }))
        .toBeVisible();
      await expect
        .element(
          screen.getByRole('button', { name: '不是这个工作流', exact: true }),
        )
        .toBeVisible();
      await expect
        .element(screen.getByRole('button', { name: '取消运行', exact: true }))
        .toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `.vitest/attachments/workrun-confirmation-${theme}-${width}.png`,
      });
    }
  }
  document.documentElement.classList.remove('dark');
  expect(decide).not.toHaveBeenCalled();
  await screen.getByRole('button', { name: '确认执行' }).click();
  expect(decide).toHaveBeenCalledExactlyOnceWith('approve');
});
