import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';

import zh from '@/locales/zh_CN.json';

import '@/styles/global.css';

import { ScheduleMessageList } from './schedule-message-list';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/components/app-sidebar', () => ({
  useEntryWorkspace: () => 'personal',
}));
vi.mock('@/services/schedules', () => ({
  getSchedule: vi.fn(),
  listSchedules: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          zh,
        ) || key,
    i18n: { language: 'zh-CN' },
  }),
}));

it('uses homepage hover, keyboard-focus and copy feedback rules for both message roles', async () => {
  await page.viewport(1280, 900);
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  try {
    const props = {
      positionKey: 'schedule:message-actions',
      messages: [
        { id: 'user', role: 'user' as const, text: '查询上海天气' },
        { id: 'old', role: 'assistant' as const, text: '第一条天气回答' },
        { id: 'latest', role: 'assistant' as const, text: '最新天气回答' },
      ],
      proposals: [],
      questions: [],
      stream: '',
      activities: [],
      active: false,
      disabled: false,
      interrupted: false,
      onDecision: vi.fn(),
      onAnswer: vi.fn(),
    };
    const view = (active = false) => (
      <MemoryRouter>
        <div className='workrun-shell workrun-navigation bg-background text-foreground h-dvh p-6'>
          <input aria-label='Focus outside messages' />
          <div className='h-[700px]'>
            <ScheduleMessageList
              {...props}
              active={active}
              stream={active ? '正在生成天气建议' : ''}
            />
          </div>
        </div>
      </MemoryRouter>
    );
    const screen = await render(view());
    const row = (text: string) =>
      page
        .getByText(text, { exact: true })
        .element()
        .closest('[data-slot="message"]')!;
    const old = row('第一条天气回答').querySelector<HTMLElement>(
      '[data-slot="message-footer"]',
    )!;
    const latest = row('最新天气回答').querySelector<HTMLElement>(
      '[data-slot="message-footer"]',
    )!;
    await page.getByRole('textbox', { name: 'Focus outside messages' }).click();
    expect(window.matchMedia('(hover: hover)').matches).toBe(true);
    await expect.poll(() => getComputedStyle(old).opacity).toBe('0');
    expect(getComputedStyle(latest).opacity).toBe('1');
    await page.getByText('第一条天气回答', { exact: true }).hover();
    await expect.poll(() => getComputedStyle(old).opacity).toBe('1');
    expect(old.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      row('第一条天气回答')
        .querySelector('[data-slot="bubble"]')!
        .getBoundingClientRect().bottom,
    );
    await page.getByRole('textbox', { name: 'Focus outside messages' }).click();
    await expect.poll(() => getComputedStyle(old).opacity).toBe('0');
    old.querySelector<HTMLButtonElement>('button')!.focus();
    await expect.poll(() => getComputedStyle(old).opacity).toBe('1');
    await userEvent.keyboard('{Enter}');
    await expect
      .poll(() => writeText.mock.calls.at(-1)?.[0])
      .toBe('第一条天气回答');
    await expect
      .poll(() => old.querySelector('button')?.getAttribute('aria-label'))
      .toBe(zh.assistant.copied);
    await page
      .getByRole('button', { name: zh.assistant.copy, exact: true })
      .last()
      .click();
    await expect
      .poll(() => writeText.mock.calls.at(-1)?.[0])
      .toBe('最新天气回答');
    await page.getByText('查询上海天气', { exact: true }).hover();
    await page
      .getByRole('button', { name: zh.assistant.copy, exact: true })
      .first()
      .click();
    await expect
      .poll(() => writeText.mock.calls.at(-1)?.[0])
      .toBe('查询上海天气');
    await screen.rerender(view(true));
    await expect
      .element(page.getByText('正在生成天气建议', { exact: true }))
      .toBeVisible();
    expect(
      row('正在生成天气建议').querySelector('[data-slot="message-footer"]'),
    ).toBeNull();
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
});
