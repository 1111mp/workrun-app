import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  SidebarMenuAction,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  SidebarRail,
  Skeleton,
  useSidebar,
} from '@workspace/ui/components';
import {
  AppWindowIcon,
  HistoryIcon,
  HomeIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  Trash2Icon,
  ArrowUpRightIcon,
  SquarePen,
  WorkflowIcon,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

import { useConfirm } from '@/lib/confirm-context';
import { runDetailsPath } from '@/services/run-center';
import { deleteRunRecord, listRunHistoryPage } from '@/services/run-history';
import { useWorkrunStore } from '@/stores';
import { useAssistantStore } from '@/stores/assistant.store';
import { useRunWorkspaceStore } from '@/stores/run-workspace.store';

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
  const loadAssistantList = useAssistantStore(
    (state) => state.loadAssistantList,
  );
  const { t } = useTranslation();
  const { pathname, search, key } = useLocation();
  const { setOpenMobile } = useSidebar();
  const workspace = useEntryWorkspace();
  const mode = useWorkrunStore((state) => state.config?.workspace_mode);
  const entries = useAssistantStore((state) => state.summaries[workspace]);
  const syncError = useAssistantStore((state) => state.listErrors[workspace]);
  const conversations = { data: entries, isPending: entries === undefined };
  useEffect(() => {
    const refresh = () => {
      void loadAssistantList(workspace).catch(() => {});
    };
    refresh();
    const recover = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', recover);
    return () => window.removeEventListener('focus', recover);
  }, [workspace, loadAssistantList]);
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
    <Sidebar variant='inset' collapsible='icon'>
      <SidebarHeader>
        <div
          data-tauri-drag-region={OS_PLATFORM !== 'win32'}
          className='h-2 shrink-0'
        />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size='lg'
              className='h-12! p-0! group-data-[collapsible=icon]:h-12! group-data-[collapsible=icon]:w-8!'
              tooltip='Workrun'
              aria-label='Workrun'
              render={<Link to='/settings' />}
            >
              <div className='bg-sidebar-primary text-sidebar-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg'>
                <WorkflowIcon />
              </div>
              <span className='flex min-w-0 flex-col truncate'>
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
              render={<Link to='/start' state={{ reset: key }} />}
            >
              <SquarePen />
              <span>{t('start.newTask')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarGroup>
        <SidebarMenu>
          {navigation.map(({ to, label, icon: Icon }) => (
            <SidebarMenuItem key={to}>
              <SidebarMenuButton
                tooltip={label}
                aria-label={label}
                isActive={
                  pathname === to ||
                  (to === '/start' && pathname === '/') ||
                  (to !== '/start' && pathname.startsWith(`${to}/`))
                }
                render={<Link to={to} />}
              >
                <Icon />
                <span>{label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
      <SidebarContent>
        <SidebarGroup className='group-data-[collapsible=icon]:hidden'>
          <SidebarGroupLabel>
            {t('assistant.recentConversations')}
          </SidebarGroupLabel>
          <SidebarMenu>
            {conversations.data?.map((conversation) => (
              <SidebarMenuItem key={conversation.id}>
                <SidebarMenuButton
                  title={conversation.title}
                  isActive={
                    pathname === '/start' &&
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
                <RecentActions
                  kind='conversation'
                  id={conversation.id}
                  name={conversation.title}
                  to={`/start?${new URLSearchParams({ session: conversation.id })}`}
                />
              </SidebarMenuItem>
            ))}
            {conversations.isPending && !syncError && (
              <SidebarMenuItem>
                <Skeleton className='h-8 w-full' />
              </SidebarMenuItem>
            )}
            {conversations.data?.length === 0 && (
              <li className='text-muted-foreground px-2 py-1 text-xs'>
                {t('sidebar.noConversations')}
              </li>
            )}
            {syncError && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() =>
                    void loadAssistantList(workspace).catch(() => {})
                  }
                >
                  {t('assistant.retryConversations')}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className='group-data-[collapsible=icon]:hidden'>
          <SidebarGroupLabel>{t('start.recentRuns')}</SidebarGroupLabel>
          <SidebarMenu>
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
                  <HistoryIcon />
                  <span>{run.targetName}</span>
                </SidebarMenuButton>
                <RecentActions
                  kind='run'
                  id={run.id}
                  name={run.targetName}
                  to={runDetailsPath(run)}
                  canDelete={['completed', 'failed', 'cancelled'].includes(
                    run.status,
                  )}
                />
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
      <SidebarFooter>{accountMenu}</SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function RecentActions({
  kind,
  id,
  name,
  to,
  canDelete = true,
}: {
  kind: 'conversation' | 'run';
  id: string;
  name: string;
  to: string;
  canDelete?: boolean;
}) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();
  const client = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  const workspace = useEntryWorkspace();
  const remove = () =>
    confirm({
      title: t('sidebar.deleteTitle', { name }),
      description: t(
        kind === 'conversation'
          ? 'sidebar.deleteConversationDescription'
          : 'sidebar.deleteRunDescription',
      ),
      confirmText: t('sidebar.delete'),
      actionVariant: 'destructive',
      onConfirm: async () => {
        await (kind === 'conversation'
          ? useAssistantStore.getState().deleteAssistantSession(id, workspace)
          : deleteRunRecord(id));
        if (kind === 'run') useRunWorkspaceStore.getState().closeRun(id);
        const params = new URLSearchParams(location.search);
        if (
          (kind === 'conversation' &&
            location.pathname === '/start' &&
            params.get('session') === id) ||
          (kind === 'run' && params.get('runId') === id)
        ) {
          await navigate(kind === 'conversation' ? '/start' : '/runs', {
            replace: true,
          });
        }
        if (kind === 'run') {
          await client.invalidateQueries({ queryKey: ['run-history'] });
          await client.invalidateQueries({
            queryKey: ['run-history-timeline'],
          });
        }
        client.removeQueries({
          queryKey:
            kind === 'conversation'
              ? ['assistant-session', workspace, id]
              : ['run-history', id],
        });
      },
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuAction
            showOnHover
            aria-label={t('sidebar.more', { name })}
          />
        }
      >
        <MoreHorizontalIcon />
        <span className='sr-only'>{t('sidebar.more', { name })}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className='w-48'
        side={isMobile ? 'bottom' : 'right'}
        align={isMobile ? 'end' : 'start'}
      >
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to={to} />}>
            <ArrowUpRightIcon />
            {t('sidebar.open')}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant='destructive'
            disabled={!canDelete}
            onClick={() => void remove()}
          >
            <Trash2Icon />
            {t('sidebar.delete')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
