import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@workspace/ui/components', () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid='navigation-provider'>{children}</div>
  ),
  SidebarInset: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  SidebarTrigger: () => <button>Toggle navigation</button>,
}));
vi.mock('@/components/conversation-title', () => ({
  ConversationTitle: () => <span>start.newTask</span>,
}));
vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: () => <nav data-testid='global-navigation' />,
}));
vi.mock('@/components/run-center', () => ({
  RunCenter: () => <div data-testid='run-center' />,
}));
const tracker = vi.hoisted(() => ({ mounted: vi.fn(), disposed: vi.fn() }));
vi.mock('@/components/run-event-tracker', () => ({
  RunEventTracker: () => {
    useEffect(() => {
      tracker.mounted();
      return tracker.disposed;
    }, []);
    return <div data-testid='run-tracker' />;
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { WorkspaceFrame } from './workspace-frame';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('OS_PLATFORM', 'darwin');
});

it.each([
  '/workflows/new',
  '/workflows/report',
  '/workflows/report?catalog=true&runId=run-1',
])('gives %s its own workspace without nested global navigation', (path) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <WorkspaceFrame accountMenu={null}>
        <div>Workflow editor</div>
      </WorkspaceFrame>
    </MemoryRouter>,
  );
  expect(screen.getByText('Workflow editor')).toBeInTheDocument();
  expect(screen.queryByTestId('global-navigation')).not.toBeInTheDocument();
  expect(screen.queryByTestId('navigation-provider')).not.toBeInTheDocument();
  expect(screen.queryByTestId('run-center')).not.toBeInTheDocument();
  expect(screen.getByTestId('run-tracker')).toBeInTheDocument();
  expect(
    document.querySelector('[data-tauri-drag-region]'),
  ).not.toBeInTheDocument();
});

it.each(['/start', '/workflows', '/apps'])(
  'keeps the navigation shell on %s',
  (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <WorkspaceFrame accountMenu={null}>Page</WorkspaceFrame>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('global-navigation')).toBeInTheDocument();
    expect(screen.getByTestId('run-center')).toBeInTheDocument();
  },
);

it('restores navigation when returning from the editor to the workflow list', () => {
  function Content() {
    const navigate = useNavigate();
    return (
      <WorkspaceFrame accountMenu={null}>
        <button onClick={() => void navigate('/workflows')}>
          Back to workflows
        </button>
      </WorkspaceFrame>
    );
  }
  render(
    <MemoryRouter initialEntries={['/workflows/report']}>
      <Content />
    </MemoryRouter>,
  );
  expect(screen.queryByTestId('global-navigation')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to workflows' }));
  expect(screen.getByTestId('global-navigation')).toBeInTheDocument();
  expect(screen.getByTestId('run-tracker')).toBeInTheDocument();
  expect(tracker.mounted).toHaveBeenCalledOnce();
  expect(tracker.disposed).not.toHaveBeenCalled();
});
