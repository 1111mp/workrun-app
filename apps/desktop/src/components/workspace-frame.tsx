import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation } from 'react-router';

import { AppSidebar } from '@/components/app-sidebar';
import { ConversationTitle } from '@/components/conversation-title';
import { RunCenter } from '@/components/run-center';
import { RunEventTracker } from '@/components/run-event-tracker';
import { WorkspaceHeaderHost } from '@/components/workspace-header-content';

export function WorkspaceFrame({
  accountMenu,
  children,
}: {
  accountMenu: ReactNode;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const schedules = pathname.startsWith('/schedules');
  const start = pathname === '/start' || pathname === '/';

  // The editor owns its node sidebar and toolbar. Nesting it in the navigation
  // shell wastes canvas space and leaks outer sidebar state into its controls.
  const editor = matchPath('/workflows/:id', pathname);
  return (
    <WorkspaceHeaderHost.Provider value={headerHost}>
      <RunEventTracker />
      {editor ? (
        <div
          data-slot='workflow-workspace'
          className='bg-background flex h-dvh min-h-0 flex-col overflow-hidden'
        >
          <div className='min-h-0 flex-1'>{children}</div>
        </div>
      ) : (
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          className='workrun-shell workrun-navigation h-dvh min-h-0 overflow-hidden'
        >
          <AppSidebar accountMenu={accountMenu} />
          <SidebarInset className='workrun-surface min-h-0 min-w-0 overflow-hidden'>
            <header
              data-tauri-drag-region={OS_PLATFORM !== 'win32'}
              className={cn(
                'workrun-topbar flex h-12 shrink-0 items-center gap-3 px-4',
                OS_PLATFORM === 'darwin' && 'pl-20 md:pl-4',
              )}
            >
              <SidebarTrigger />
              {schedules ? (
                <div
                  ref={setHeaderHost}
                  data-workspace-header-slot
                  className='flex h-full min-w-0 flex-1 items-center'
                />
              ) : (
                <>
                  <span className='text-muted-foreground truncate text-sm'>
                    {start ? (
                      <ConversationTitle />
                    ) : pathname.startsWith('/workflows') ? (
                      t('navigation.workflow')
                    ) : pathname.startsWith('/apps') ? (
                      t('navigation.apps')
                    ) : pathname === '/profile' ? (
                      t('profile.title')
                    ) : pathname === '/mcp-servers' ? (
                      t('navigation.mcpServers')
                    ) : pathname === '/runs' ? (
                      t('navigation.runHistory')
                    ) : (
                      t('navigation.settings')
                    )}
                  </span>
                  <div data-tauri-drag-region className='h-full flex-1' />
                  {start && (
                    <div
                      ref={setHeaderHost}
                      data-workspace-header-slot
                      className='flex shrink-0 items-center'
                    />
                  )}
                </>
              )}
            </header>
            <div className='min-h-0 flex-1 [view-transition-name:page-content]'>
              {children}
            </div>
            <RunCenter />
          </SidebarInset>
        </SidebarProvider>
      )}
    </WorkspaceHeaderHost.Provider>
  );
}
