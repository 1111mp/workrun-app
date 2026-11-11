import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@workspace/ui/components';
import { Fragment, type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';

import { createTeamAuthClient } from '@/lib/auth-client';
import { getTeamUser } from '@/services/session';
import { syncTeamModelSession } from '@/services/team-model-session';
import { useWorkrunStore } from '@/stores';

const MINIMUM_LOADING_DURATION = 300;

function TeamSessionGate({ children }: { children: ReactNode }) {
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);
  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);

  if (workspaceMode !== 'team') return children;
  if (!serverUrl) return <Navigate replace to='/login' />;
  return (
    <AuthenticatedTeamGate key={serverUrl} serverUrl={serverUrl}>
      {children}
    </AuthenticatedTeamGate>
  );
}

function AuthenticatedTeamGate({
  children,
  serverUrl,
}: {
  children: ReactNode;
  serverUrl: string;
}) {
  const { t } = useTranslation();
  const authClient = useMemo(
    () => createTeamAuthClient(serverUrl),
    [serverUrl],
  );
  const { data: session, isPending } = authClient.useSession();
  const token = session?.session.token;
  const teamUser = useQuery({
    enabled: !isPending,
    queryFn: async ({ signal }) => {
      const startedAt = Date.now();
      try {
        await syncTeamModelSession(serverUrl, token ?? null);
        signal.throwIfAborted();
        await useWorkrunStore.persist.rehydrate();
        signal.throwIfAborted();
        const user = token ? await getTeamUser(serverUrl) : null;
        signal.throwIfAborted();
        if (user && user.id !== session?.user.id)
          throw new Error('Team account changed');
        useWorkrunStore.getState().setTeamUser(user ?? undefined);
        return user;
      } finally {
        const remaining = MINIMUM_LOADING_DURATION - (Date.now() - startedAt);
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
      }
    },
    queryKey: ['team-user', serverUrl, token],
    // A local team server can be reachable even when the browser reports offline.
    networkMode: 'always',
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  if (isPending || teamUser.isPending || teamUser.isFetching) {
    return (
      <div
        aria-busy
        aria-label={t('onboarding.login.checkingSession')}
        className='workrun-shell flex h-dvh min-h-0 flex-col overflow-hidden'
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
    return (
      <Navigate
        replace
        to='/login'
        state={teamUser.isError ? { sessionUnavailable: true } : undefined}
      />
    );
  }

  return <Fragment key={session?.user.id}>{children}</Fragment>;
}

export { TeamSessionGate };
