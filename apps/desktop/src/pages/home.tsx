import { check } from '@tauri-apps/plugin-updater';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@workspace/ui/components';
import {
  BoxesIcon,
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

import { useUpdaterStore } from '@/stores';

const navigation = [
  { to: '/workflows', labelKey: 'navigation.workflow', icon: WorkflowIcon },
  {
    to: '/apps',
    labelKey: 'navigation.apps',
    icon: BoxesIcon,
  },
];

function HomePage() {
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const { t } = useTranslation();
  const navigate = useNavigate();

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

  return (
    <div className='flex h-dvh min-h-0 flex-col overflow-hidden bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_95%_93%/0.8),transparent),radial-gradient(ellipse_70%_55%_at_100%_25%,hsl(270_95%_94%/0.55),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_95%_94%/0.42),transparent)] dark:bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_70%_20%/0.5),transparent),radial-gradient(ellipse_70%_55%_at_100%_25%,hsl(270_65%_19%/0.4),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_70%_18%/0.32),transparent)]'>
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
                  <AvatarImage src='https://github.com/shadcn.png' />
                  <AvatarFallback>
                    <User />
                  </AvatarFallback>
                </Avatar>
              </Button>
            }
          />
          <DropdownMenuContent align='end' className='w-44'>
            <DropdownMenuItem onClick={() => navigate('/settings')}>
              <SettingsIcon />
              {t('navigation.settings')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate('/mcp-servers')}>
              <ServerCogIcon />
              MCP servers
            </DropdownMenuItem>
            <DropdownMenuSeparator />
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
