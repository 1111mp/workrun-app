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
  PlusIcon,
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
          className={OS_PLATFORM === 'darwin' ? 'h-7 shrink-0' : 'h-2 shrink-0'}
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
              <PlusIcon />
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
                  <Icon />
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
