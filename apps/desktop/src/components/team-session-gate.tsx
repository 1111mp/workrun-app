import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@workspace/ui/components';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';

import { getTeamUser } from '@/services/session';
import { useWorkrunStore } from '@/stores';

const MINIMUM_LOADING_DURATION = 300;

function TeamSessionGate({ children }: { children: ReactNode }) {
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);
  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);

  const { t } = useTranslation();

  const requiresSession = workspaceMode === 'team';

  const teamUser = useQuery({
    enabled: requiresSession && Boolean(serverUrl),
    queryFn: async () => {
      const startedAt = Date.now();
      try {
        const user = await getTeamUser(serverUrl!);
        useWorkrunStore.getState().setTeamUser(user ?? undefined);
        return user;
      } finally {
        const remaining = MINIMUM_LOADING_DURATION - (Date.now() - startedAt);
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
      }
    },
    queryKey: ['team-user', serverUrl],
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (!requiresSession) return children;

  if (!serverUrl) {
    return <Navigate replace to='/login' />;
  }

  if (teamUser.isPending) {
    return (
      <div
        aria-busy
        aria-label={t('onboarding.login.checkingSession')}
        className='flex h-dvh min-h-0 flex-col overflow-hidden'
        role='status'
      >
        <header
          className='flex h-12 shrink-0 items-center gap-3 border-b pr-4 pl-20'
          data-tauri-drag-region={OS_PLATFORM !== 'win32'}
        >
          <Skeleton className='h-4 w-16' />
          <Skeleton className='h-7 w-20 rounded-md' />
          <Skeleton className='h-7 w-16 rounded-md' />
          <Skeleton className='ml-auto size-7 rounded-full' />
        </header>
        <main className='mx-auto w-full max-w-6xl flex-1 space-y-6 p-8'>
          <div className='space-y-3'>
            <Skeleton className='h-7 w-44' />
            <Skeleton className='h-4 w-72' />
          </div>
          <div className='grid grid-cols-3 gap-4'>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton className='h-32 rounded-xl' key={index} />
            ))}
          </div>
        </main>
      </div>
    );
  }

  if (teamUser.isError || !teamUser.data) {
    return <Navigate replace to='/login' />;
  }

  return children;
}

export { TeamSessionGate };
