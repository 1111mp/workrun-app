import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  getProcessNodes,
  startBackgroundProcessNodeRun,
  subscribeProcessNodeRun,
  type ProcessNode,
  type ProcessNodeRunEvent,
} from '@/services/process-node';

import { Component as AppsPage } from './index';

vi.mock('@/services/process-node', () => ({
  getProcessNodes: vi.fn(),
  startBackgroundProcessNodeRun: vi.fn(),
  subscribeProcessNodeRun: vi.fn(),
}));
vi.mock('@/services/run-history', () => ({
  inspectRunRecord: vi.fn(),
  listRunHistoryPage: vi.fn(),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
}));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => false }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
vi.mock('@workspace/ui/components', () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const button = ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
  return {
    ...Object.fromEntries(
      [
        'Alert',
        'AlertAction',
        'AlertDescription',
        'AlertTitle',
        'Badge',
        'Button',
        'Card',
        'CardAction',
        'CardContent',
        'CardDescription',
        'CardFooter',
        'CardHeader',
        'CardTitle',
        'Drawer',
        'DrawerContent',
        'DrawerDescription',
        'DrawerFooter',
        'DrawerHeader',
        'DrawerTitle',
        'Empty',
        'EmptyContent',
        'EmptyDescription',
        'EmptyHeader',
        'EmptyMedia',
        'EmptyTitle',
        'InputGroup',
        'InputGroupAddon',
        'InputGroupInput',
        'Item',
        'ItemActions',
        'ItemContent',
        'ItemDescription',
        'ItemGroup',
        'ItemTitle',
        'Progress',
        'ProgressLabel',
        'ProgressValue',
        'Skeleton',
        'Spinner',
      ].map((name) => [name, box]),
    ),
    Button: button,
    InputGroupInput: () => <input />,
  };
});

const node: ProcessNode = {
  definition: {
    id: 'report',
    name: 'Report',
    description: '',
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
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getProcessNodes).mockResolvedValue([node]);
  vi.mocked(startBackgroundProcessNodeRun).mockResolvedValue(undefined);
});
async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider
        router={createMemoryRouter([{ path: '*', Component: AppsPage }])}
      />
    </QueryClientProvider>,
  );
  await screen.findByText('Report');
  return { client, view };
}

it('releases a registration that finishes after navigation without starting the App', async () => {
  let resolve!: (stop: () => void) => void;
  const stop = vi.fn();
  vi.mocked(subscribeProcessNodeRun).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { client, view } = await mount();
  fireEvent.click(screen.getByRole('button', { name: 'apps.run' }));
  await vi.waitFor(() =>
    expect(subscribeProcessNodeRun).toHaveBeenCalledOnce(),
  );
  view.unmount();
  await act(async () => {
    resolve(stop);
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(startBackgroundProcessNodeRun).not.toHaveBeenCalled();
  client.clear();
});

it.each(['error', 'app_done', 'app_cancelled'] as const)(
  'releases the App listener on %s',
  async (type) => {
    const stop = vi.fn();
    let receive!: (event: ProcessNodeRunEvent) => void;
    vi.mocked(subscribeProcessNodeRun).mockImplementationOnce(
      async (_id, callback) => {
        receive = callback;
        return stop;
      },
    );
    const { client, view } = await mount();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'apps.run' }));
      await vi.waitFor(() =>
        expect(startBackgroundProcessNodeRun).toHaveBeenCalledOnce(),
      );
      await act(async () => {
        receive(
          type === 'error'
            ? { type, message: 'Failed' }
            : type === 'app_cancelled'
              ? { type }
              : { type, execution: { exitCode: 0, scriptPath: 'main.py' } },
        );
      });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      client.clear();
    }
    expect(stop).toHaveBeenCalledOnce();
  },
);
