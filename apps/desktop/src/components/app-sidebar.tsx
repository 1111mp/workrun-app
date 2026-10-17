import { useQuery } from '@tanstack/react-query';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  Skeleton,
  useSidebar,
} from '@workspace/ui/components';
import {
  AppWindowIcon,
  HistoryIcon,
  HomeIcon,
  MessageSquareIcon,
  SquarePen,
  WorkflowIcon,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { listAssistantSessions } from '@/services/assistant';
import { runDetailsPath } from '@/services/run-center';
import { listRunHistoryPage } from '@/services/run-history';
import { useWorkrunStore } from '@/stores';

export function useEntryWorkspace() {
  return useWorkrunStore((state) =>
    JSON.stringify([
      state.config?.workspace_mode ?? 'personal',
      state.config?.workspace_mode === 'team'
        ? state.config.team?.server_url
        : '',
      state.config?.workspace_mode === 'team' ? state.teamUser?.id : '',
    ]),
  );
}

export function AppSidebar({ accountMenu }: { accountMenu: ReactNode }) {
  const { t } = useTranslation();
  const { pathname, search, key } = useLocation();
  const { setOpenMobile } = useSidebar();
  const workspace = useEntryWorkspace();
  const mode = useWorkrunStore((state) => state.config?.workspace_mode);
  const conversations = useQuery({
    queryKey: ['assistant-sessions', workspace],
    queryFn: listAssistantSessions,
  });
  const recent = useQuery({
    queryKey: ['run-history', 'entry-recent', workspace],
    queryFn: () => listRunHistoryPage({ pageSize: 15 }),
  });

  useEffect(() => {
    setOpenMobile(false);
  }, [key, setOpenMobile]);

  const navigation = [
    { to: '/start', label: t('start.home'), icon: HomeIcon },
    { to: '/workflows', label: t('navigation.workflow'), icon: WorkflowIcon },
    { to: '/apps', label: t('navigation.apps'), icon: AppWindowIcon },
    { to: '/runs', label: t('navigation.runHistory'), icon: HistoryIcon },
  ];

  return (
    <Sidebar
      variant='inset'
      collapsible='icon'
      // Include the inset's left margin so controls center in the visible rail.
      className='group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(6)))]'
    >
      <SidebarHeader>
        <div
          data-tauri-drag-region={OS_PLATFORM !== 'win32'}
          className='h-2 shrink-0'
        />
        <SidebarMenu className='group-data-[collapsible=icon]:items-center'>
          <SidebarMenuItem>
            <SidebarMenuButton
              size='lg'
              tooltip='Workrun'
              aria-label='Workrun'
              className='group-data-[collapsible=icon]:justify-center'
              render={<Link to='/settings' />}
            >
              <WorkflowIcon />
              <span className='flex min-w-0 flex-col truncate group-data-[collapsible=icon]:hidden'>
                <span className='font-semibold'>Workrun</span>
                <span className='text-muted-foreground text-xs'>
                  {t(
                    mode === 'team'
                      ? 'start.teamWorkspace'
                      : 'start.personalWorkspace',
                  )}
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t('start.newTask')}
              aria-label={t('start.newTask')}
              className='group-data-[collapsible=icon]:justify-center'
              render={<Link to='/start' state={{ reset: key }} />}
            >
              <SquarePen />
              <span className='group-data-[collapsible=icon]:hidden'>
                {t('start.newTask')}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className='group-data-[collapsible=icon]:items-center'>
            {navigation.map(({ to, label, icon: Icon }) => (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton
                  tooltip={label}
                  aria-label={label}
                  className='group-data-[collapsible=icon]:justify-center'
                  isActive={
                    pathname === to ||
                    (to !== '/start' && pathname.startsWith(`${to}/`))
                  }
                  render={<Link to={to} />}
                >
                  <Icon className='group-data-active/menu-button:hidden' />
                  <svg
                    viewBox='0 0 24 24'
                    fill='currentColor'
                    aria-hidden='true'
                    className='hidden group-data-active/menu-button:block'
                  >
                    {to === '/start' && (
                      <path
                        fillRule='evenodd'
                        d='M11.1 2.7a1.5 1.5 0 0 1 1.8 0l8 6A2.5 2.5 0 0 1 22 10.7V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9.3a2.5 2.5 0 0 1 1.1-2l8-6ZM10 14v8h4v-8h-4Z'
                        clipRule='evenodd'
                      />
                    )}
                    {to === '/workflows' && (
                      <>
                        <rect x='2' y='2' width='8' height='8' rx='2' />
                        <rect x='14' y='14' width='8' height='8' rx='2' />
                        <path d='M5 10v5a4 4 0 0 0 4 4h5v-2H9a2 2 0 0 1-2-2v-5H5Z' />
                      </>
                    )}
                    {to === '/apps' && (
                      <path
                        fillRule='evenodd'
                        d='M4 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Zm0 5v11h16V8H4Zm1-3v1h2V5H5Zm4 0v1h2V5H9Z'
                        clipRule='evenodd'
                      />
                    )}
                    {to === '/runs' && (
                      <>
                        <path
                          fillRule='evenodd'
                          d='M12 3a9 9 0 1 1-8.5 12h2.2A7 7 0 1 0 6 8.4L4.5 7A9 9 0 0 1 12 3Zm-1 4h2v4.5l3.5 2-1 1.7L11 12.7V7Z'
                          clipRule='evenodd'
                        />
                        <path d='M2 3v7h7L2 3Z' />
                      </>
                    )}
                  </svg>
                  <span className='group-data-[collapsible=icon]:hidden'>
                    {label}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className='group-data-[collapsible=icon]:hidden'>
          <SidebarGroupLabel>
            {t('assistant.recentConversations')}
          </SidebarGroupLabel>
          <SidebarMenu className='group-data-[collapsible=icon]:items-center'>
            {conversations.data?.map((conversation) => (
              <SidebarMenuItem key={conversation.id}>
                <SidebarMenuButton
                  isActive={
                    new URLSearchParams(search).get('session') ===
                    conversation.id
                  }
                  render={
                    <Link
                      to={`/start?${new URLSearchParams({ session: conversation.id })}`}
                    />
                  }
                >
                  <MessageSquareIcon />
                  <span>{conversation.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {conversations.isError && (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => void conversations.refetch()}>
                  {t('assistant.retryConversations')}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className='group-data-[collapsible=icon]:hidden'>
          <SidebarGroupLabel>{t('start.recentRuns')}</SidebarGroupLabel>
          <SidebarMenu className='group-data-[collapsible=icon]:items-center'>
            {recent.isPending && <Skeleton className='h-8 w-full' />}
            {recent.isError && (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => void recent.refetch()}>
                  {t('start.retryHistory')}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {recent.data?.items.map((run) => (
              <SidebarMenuItem key={run.id}>
                <SidebarMenuButton
                  title={run.targetName}
                  isActive={new URLSearchParams(search).get('runId') === run.id}
                  render={<Link to={runDetailsPath(run)} />}
                >
                  <MessageSquareIcon />
                  <span>{run.targetName}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {recent.data?.items.length === 0 && (
              <li className='text-muted-foreground px-2 py-1 text-xs'>
                {t('start.noRecentRuns')}
              </li>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className='group-data-[collapsible=icon]:items-center'>
        {accountMenu}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
