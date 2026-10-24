import '@/styles/global.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import en from '@/locales/en.json';
import zh from '@/locales/zh_CN.json';
import {
  startBackgroundProcessNodeRun,
  type ProcessNode,
  type ProcessNodeRunEvent,
} from '@/services/process-node';

import { Component as AppsPage } from './index';

const state = vi.hoisted(() => ({
  locale: 'zh' as 'zh' | 'en',
  receive: undefined as ((event: ProcessNodeRunEvent) => void) | undefined,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (object, part) => (object as Record<string, unknown>)?.[part],
          state.locale === 'zh' ? zh : en,
        );
      return typeof value === 'string'
        ? value.replace(/{{(\w+)}}/g, (_, name: string) =>
            String(params?.[name] ?? ''),
          )
        : key;
    },
  }),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
}));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => false }));
vi.mock('@/services/process-node', () => ({
  getProcessNodes: async () =>
    Array.from({ length: 6 }, (_, index): ProcessNode => ({
      definition: {
        id: `report-${index}`,
        name: `Report ${index}`,
        description: 'Generate a reusable report from the provided data.',
        version: '1',
        createdAt: '',
        updatedAt: '',
        entry: 'main.py',
        kind: 'workflow',
        toolExecutionPolicy: 'ask_every_time',
        inputs: {},
        outputs: {},
      },
      projectPath: '/tmp/report',
      installStatus: 'installed',
    })),
  startBackgroundProcessNodeRun: vi.fn(async () => {}),
  ensurePublishedProcessNode: vi.fn(),
  subscribeProcessNodeRun: async (
    _id: string,
    receive: typeof state.receive,
  ) => {
    state.receive = receive;
    return () => {};
  },
}));
vi.mock('@/services/run-history', () => ({
  inspectRunRecord: vi.fn(),
  listRunHistoryPage: vi.fn(),
}));
vi.mock('./project-path', () => ({
  copyProjectPath: vi.fn(),
  openProjectDirectory: vi.fn(),
}));
vi.mock('@/components/app-run-output-panel', () => ({
  AppRunOutputPanel: () => null,
  AppRunOutputContent: () => null,
  restoreProcessNodeRun: vi.fn(),
}));
vi.mock('@/components/app-share-dialog', () => ({
  AppExportButton: () => null,
  AppImportButton: () => null,
}));

it.each([
  ['zh', 390],
  ['zh', 1280],
  ['en', 390],
  ['en', 1280],
] as const)(
  'keeps App card heights and following rows stable during runs (%s, %ipx)',
  async (locale, width) => {
    state.locale = locale;
    vi.mocked(startBackgroundProcessNodeRun).mockClear();
    await page.viewport(width, 1000);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <RouterProvider
          router={createMemoryRouter([{ path: '*', Component: AppsPage }])}
        />
      </QueryClientProvider>,
    );
    try {
      await expect
        .element(screen.getByText('Report 5', { exact: true }))
        .toBeVisible();
      const cards = () => [...document.querySelectorAll('[data-library-kind]')];
      const positions = () =>
        cards().map((card) => {
          const rect = card.getBoundingClientRect();
          return { height: rect.height, top: rect.top + window.scrollY };
        });
      const before = positions();
      const button = cards()[0].querySelector<HTMLButtonElement>(
        '[data-process-node-id]',
      )!;
      button.click();
      await expect
        .poll(() => vi.mocked(startBackgroundProcessNodeRun).mock.calls.length)
        .toBe(1);
      await expect
        .element(button)
        .toHaveTextContent(locale === 'zh' ? zh.apps.running : en.apps.running);
      await expect.poll(() => positions()).toEqual(before);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      state.receive!({
        type: 'app_done',
        execution: { exitCode: 0, scriptPath: 'main.py' },
      });
      await expect
        .element(button)
        .toHaveTextContent(locale === 'zh' ? zh.apps.run : en.apps.run);
      await expect.poll(() => positions()).toEqual(before);
    } finally {
      await screen.unmount();
      client.clear();
    }
  },
);
