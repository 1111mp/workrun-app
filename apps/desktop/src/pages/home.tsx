import { useQueryClient } from '@tanstack/react-query';
import { check } from '@tauri-apps/plugin-updater';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SidebarMenuButton,
} from '@workspace/ui/components';
import {
  BookOpenIcon,
  ChevronsUpDown,
  LogOutIcon,
  RefreshCwIcon,
  ServerCogIcon,
  SettingsIcon,
  User,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { DeeplinkHandler } from '@/components/deeplink-handler';
import { TeamSessionGate } from '@/components/team-session-gate';
import { WorkspaceFrame } from '@/components/workspace-frame';
import { createTeamAuthClient } from '@/lib/auth-client';
import {
  selectWorkspaceUserInfo,
  useUpdaterStore,
  useWorkrunStore,
} from '@/stores';

function HomePage() {
  return (
    <TeamSessionGate>
      <DeeplinkHandler />
      <HomeLayout />
    </TeamSessionGate>
  );
}

function HomeLayout() {
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);

  const userInfo = useWorkrunStore(useShallow(selectWorkspaceUserInfo));
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);
  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);
  const availableUpdate = useUpdaterStore((s) => s.update);
  const queryClient = useQueryClient();

  const navigate = useNavigate();
  const { t } = useTranslation();

  const displayName = userInfo?.name;
  const avatarUrl = userInfo?.avatarUrl;

  const checkForUpdates = async () => {
    if (checkingForUpdates) return;

    if (availableUpdate) {
      useUpdaterStore.getState().setOpen(true);
      return;
    }

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
    <WorkspaceFrame
      accountMenu={
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size='lg'
                aria-label={displayName || t('navigation.accountMenu')}
                className='data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground relative h-12! p-0! group-data-[collapsible=icon]:h-12! group-data-[collapsible=icon]:w-8!'
              >
                <Avatar className='size-8 shrink-0 rounded-lg'>
                  <AvatarImage src={avatarUrl ?? ''} alt={displayName ?? ''} />
                  <AvatarFallback className='rounded-lg'>
                    <User />
                  </AvatarFallback>
                </Avatar>

                <div className='grid min-w-0 flex-1 text-left text-sm leading-tight'>
                  <span className='truncate font-medium'>
                    {displayName || t('navigation.accountMenu')}
                  </span>
                  {availableUpdate ? (
                    <span
                      className='ring-background absolute top-2 left-2 size-1.5 rounded-full bg-red-500 ring-2'
                      aria-label={t('updater.available')}
                    />
                  ) : null}
                </div>
                <ChevronsUpDown className='ml-auto size-4' />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            className='w-(--anchor-width) min-w-56 rounded-lg'
            side='right'
            align='end'
            sideOffset={4}
          >
            <DropdownMenuGroup>
              {displayName ? (
                <DropdownMenuLabel className='text-muted-foreground truncate px-2 py-1.5 text-sm font-medium'>
                  {displayName}
                </DropdownMenuLabel>
              ) : null}
              <DropdownMenuItem
                onClick={() =>
                  navigate('/mcp-servers', { viewTransition: true })
                }
              >
                <ServerCogIcon />
                {t('navigation.mcpServers')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => navigate('/skills', { viewTransition: true })}
              >
                <BookOpenIcon />
                {t('navigation.skills')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => navigate('/profile', { viewTransition: true })}
              >
                <User />
                {t('navigation.profile')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => navigate('/settings', { viewTransition: true })}
              >
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
                  : availableUpdate
                    ? t('updater.available')
                    : t('navigation.checkForUpdates')}
                {availableUpdate ? (
                  <span className='text-foreground ml-auto rounded-sm bg-red-500! px-1 py-0.5 text-[10px] leading-none font-semibold'>
                    NEW
                  </span>
                ) : null}
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
      }
    >
      <Outlet />
    </WorkspaceFrame>
  );
}

export { HomePage };
