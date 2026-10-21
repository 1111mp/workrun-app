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
import { RunCenter } from '@/components/run-center';
import { RunEventTracker } from '@/components/run-event-tracker';

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

  // The editor owns its node sidebar and toolbar. Nesting it in the navigation
  // shell wastes canvas space and leaks outer sidebar state into its controls.
  const editor = matchPath('/workflows/:id', pathname);
  return (
    <>
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
          className='h-dvh min-h-0 overflow-hidden'
        >
          <AppSidebar accountMenu={accountMenu} />
          <SidebarInset className='min-h-0 min-w-0 overflow-hidden'>
            <header
              data-tauri-drag-region={OS_PLATFORM !== 'win32'}
              className={cn(
                'flex h-12 shrink-0 items-center gap-3 px-4',
                OS_PLATFORM === 'darwin' && 'pl-20 md:pl-4',
              )}
            >
              <SidebarTrigger />
              <span className='text-muted-foreground truncate text-sm'>
                {pathname === '/start/library'
                  ? t('assistant.browse')
                  : pathname === '/start' || pathname === '/'
                    ? t('start.newTask')
                    : pathname.startsWith('/workflows')
                      ? t('navigation.workflow')
                      : pathname.startsWith('/apps')
                        ? t('navigation.apps')
                        : pathname === '/runs'
                          ? t('navigation.runHistory')
                          : t('navigation.settings')}
              </span>
              <div data-tauri-drag-region className='h-full flex-1' />
            </header>
            <div className='min-h-0 flex-1 [view-transition-name:page-content]'>
              {children}
            </div>
            <RunCenter />
          </SidebarInset>
        </SidebarProvider>
      )}
    </>
  );
}
