import { useQueryClient } from '@tanstack/react-query';
import { check } from '@tauri-apps/plugin-updater';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@workspace/ui/components';
import {
  BookOpenIcon,
  BoxesIcon,
  LogOutIcon,
  RefreshCwIcon,
  ServerCogIcon,
  SettingsIcon,
  User,
  WorkflowIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { TeamSessionGate } from '@/components/team-session-gate';
import { createTeamAuthClient } from '@/lib/auth-client';
import {
  selectWorkspaceUserInfo,
  useUpdaterStore,
  useWorkrunStore,
} from '@/stores';

const navigation = [
  { to: '/workflows', labelKey: 'navigation.workflow', icon: WorkflowIcon },
  {
    to: '/apps',
    labelKey: 'navigation.apps',
    icon: BoxesIcon,
  },
];

function HomePage() {
  return (
    <TeamSessionGate>
      <HomeLayout />
    </TeamSessionGate>
  );
}

function HomeLayout() {
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);

  const userInfo = useWorkrunStore(useShallow(selectWorkspaceUserInfo));
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);
  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);
  const queryClient = useQueryClient();

  const navigate = useNavigate();

  const { t } = useTranslation();

  const displayName = userInfo?.name;
  const avatarUrl = userInfo?.avatarUrl;

  const checkForUpdates = async () => {
    if (checkingForUpdates) return;

    setCheckingForUpdates(true);
    try {
      const update = await check();
      if (update) {
        const updater = useUpdaterStore.getState();
        updater.setUpdate(update);
        updater.setOpen(true);
      } else {
        toast.success(t('updater.upToDate'), { toasterId: 'global' });
      }
    } catch {
      toast.error(t('updater.failedToCheck'), {
        toasterId: 'global',
        description: t('updater.checkFailedDescription'),
      });
    } finally {
      setCheckingForUpdates(false);
    }
  };

  const signOut = async () => {
    if (!serverUrl) return;

    try {
      const result = await createTeamAuthClient(serverUrl).signOut();
      if (result.error) throw result.error;

      useWorkrunStore.getState().setTeamUser(undefined);
      queryClient.removeQueries({ queryKey: ['team-user', serverUrl] });
      await navigate('/login', { replace: true });
    } catch {
      toast.error(t('navigation.signOutFailed'), { toasterId: 'global' });
    }
  };

  return (
    <div className='flex h-dvh min-h-0 flex-col overflow-hidden'>
      <header
        data-tauri-drag-region={OS_PLATFORM !== 'win32'}
        className='flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-20'
      >
        <span data-tauri-drag-region className='mr-3 text-sm font-semibold'>
          Workrun
        </span>
        <nav
          aria-label={t('navigation.label')}
          className='flex items-center gap-1'
        >
          {navigation.map(({ to, labelKey, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                [
                  'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                ].join(' ')
              }
            >
              <Icon className='size-3.5' />
              {t(labelKey)}
            </NavLink>
          ))}
        </nav>
        <div data-tauri-drag-region className='flex-1' />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant='ghost'
                size='sm'
                aria-label={t('navigation.accountMenu')}
              >
                <Avatar size='sm'>
                  {avatarUrl ? (
                    <AvatarImage alt={displayName ?? ''} src={avatarUrl} />
                  ) : null}
                  <AvatarFallback>
                    <User />
                  </AvatarFallback>
                </Avatar>
              </Button>
            }
          />
          <DropdownMenuContent align='end' className='w-44'>
            <DropdownMenuGroup>
              {displayName ? (
                <DropdownMenuLabel className='text-muted-foreground truncate px-2 py-1.5 text-sm font-medium'>
                  {displayName}
                </DropdownMenuLabel>
              ) : null}
              <DropdownMenuItem onClick={() => navigate('/mcp-servers')}>
                <ServerCogIcon />
                MCP servers
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/skills')}>
                <BookOpenIcon />
                {t('navigation.skills')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/profile')}>
                <User />
                {t('navigation.profile')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate('/settings')}>
                <SettingsIcon />
                {t('navigation.settings')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={checkingForUpdates}
                onClick={() => void checkForUpdates()}
              >
                <RefreshCwIcon
                  className={checkingForUpdates ? 'animate-spin' : undefined}
                />
                {checkingForUpdates
                  ? t('navigation.checkingForUpdates')
                  : t('navigation.checkForUpdates')}
              </DropdownMenuItem>
              {workspaceMode === 'team' ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant='destructive'
                    onClick={() => void signOut()}
                  >
                    <LogOutIcon />
                    {t('navigation.signOut')}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <main className='min-h-0 flex-1'>
        <Outlet />
      </main>
    </div>
  );
}

export { HomePage };
