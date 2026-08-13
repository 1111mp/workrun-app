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
  { to: '/workflow', labelKey: 'navigation.workflow', icon: WorkflowIcon },
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
    <div className='bg-background flex h-dvh min-h-0 flex-col overflow-hidden'>
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
