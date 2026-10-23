import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import zh from '@/locales/zh_CN.json';
import type { SessionUsage as Usage } from '@/services/model-usage';

import { SessionUsage } from './session-usage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, params?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          zh,
        );
      return typeof value === 'string'
        ? value.replace(/{{(\w+)}}/g, (_, key) => {
            const val = params?.[key];
            if (val === undefined || val === null) return '';
            if (typeof val === 'object') {
              return JSON.stringify(val);
            }
            return JSON.stringify(val);
          })
        : key;
    },
  }),
}));
const total = {
  calls: 3,
  missingUsageCalls: 0,
  unfinishedCalls: 0,
  estimatedCalls: 0,
  inputTokens: 62000,
  outputTokens: 8000,
  totalTokens: 70000,
  cacheReadTokens: 5000,
  reasoningTokens: 2000,
};
const fixture: Usage = {
  conversation: total,
  execution: {
    ...total,
    calls: 1,
    inputTokens: 2000,
    outputTokens: 3000,
    totalTokens: 5000,
  },
  byPurpose: [
    {
      purpose: 'conversation',
      calls: 1,
      totalTokens: 20000,
      missingUsageCalls: 0,
    },
    {
      purpose: 'authoring',
      calls: 2,
      totalTokens: 50000,
      missingUsageCalls: 0,
    },
    { purpose: 'workflow', calls: 1, totalTokens: 5000, missingUsageCalls: 0 },
  ],
  calls: Array.from({ length: 4 }, (_, i) => ({
    id: String(i),
    model: 'deepseek-v4-flash',
    startedAt: '2026-10-22T05:00:00Z',
    status: 'completed',
    context: { purpose: i === 3 ? 'workflow' : 'authoring' },
    usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000 },
  })),
};
vi.mock('@/services/model-usage', () => ({
  getSessionUsage: async () => fixture,
}));

for (const [theme, width] of [
  ['light', 1100],
  ['dark', 1600],
  ['dark', 1100],
  ['light', 390],
] as const) {
  it(`usage overview and details fit ${theme} ${width}`, async () => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    await page.viewport(width, 850);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await render(
      <QueryClientProvider client={client}>
        <SessionUsage kind='assistant' sessionId='fixture' />
      </QueryClientProvider>,
    );
    await page.getByRole('button', { name: 'Token 用量' }).click();
    await expect.element(page.getByText(zh.usage.recordedTotal)).toBeVisible();
    await expect
      .element(page.getByText('75,000', { exact: true }))
      .toBeVisible();
    const dialog = document.querySelector('[data-slot="dialog-content"]')!;
    expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(width);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    if (width >= 1100) {
      expect(dialog.getBoundingClientRect().width).toBeGreaterThan(768);
      expect(dialog.getBoundingClientRect().width).toBeLessThanOrEqual(1000);
      expect(dialog.getBoundingClientRect().height).toBeGreaterThan(650);
      const overview = document.querySelector(
        'section[aria-label="用量概览"]',
      )!;
      const breakdown = document.querySelector(
        'section[aria-label="用在哪里"]',
      )!;
      expect(
        Math.abs(
          overview.getBoundingClientRect().top -
            breakdown.getBoundingClientRect().top,
        ),
      ).toBeLessThan(2);
    }
    document.getAnimations().forEach((animation) => animation.finish());
    await page.screenshot({
      path: `.vitest/attachments/usage-ui-${theme}-${width}.png`,
    });
    await page.getByRole('button', { name: '模型调用明细' }).click();
    await expect.element(page.getByRole('table')).toBeVisible();
    expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(850);
    const footer = page.getByText('打开时每 3 秒刷新', { exact: false });
    await expect.element(footer).toBeVisible();
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    document.getAnimations().forEach((animation) => animation.finish());
    await page.screenshot({
      path: `.vitest/attachments/usage-ui-details-${theme}-${width}.png`,
    });
    client.clear();
  });
}
