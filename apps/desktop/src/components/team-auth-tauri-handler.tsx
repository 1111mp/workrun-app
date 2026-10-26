import { useBetterAuthTauri } from '@daveyplate/better-auth-tauri/react';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { createTeamAuthClient } from '@/lib/auth-client';
import { router } from '@/routes';
import { useWorkrunStore } from '@/stores';

function TeamAuthTauriHandler() {
  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);
  return serverUrl ? (
    <ConfiguredTeamAuthTauriHandler serverUrl={serverUrl} />
  ) : null;
}

function ConfiguredTeamAuthTauriHandler({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation();

  const authClient = useMemo(
    () => createTeamAuthClient(serverUrl),
    [serverUrl],
  );

  const { data: session } = authClient.useSession();
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);
  useEffect(() => {
    // The native scheduler resolves releases without depending on an open editor.
    void invoke('schedule_set_team_session', {
      serverUrl,
      token: workspaceMode === 'team' ? (session?.session.token ?? null) : null,
    });
    return () => {
      void invoke('schedule_set_team_session', { serverUrl, token: null });
    };
  }, [serverUrl, workspaceMode, session?.session.token]);

  const onError = useCallback(() => {
    toast.error(t('onboarding.login.oauthFailed'), { toasterId: 'global' });
    void router.navigate('/login', { replace: true });
  }, [t]);

  const onSuccess = useCallback((callbackURL?: string | null) => {
    void router.navigate(callbackURL || '/workflows', { replace: true });
  }, []);

  useBetterAuthTauri({
    authClient,
    debugLogs: import.meta.env.DEV,
    onError,
    onSuccess,
    scheme: 'workrun',
  });

  return null;
}

export { TeamAuthTauriHandler };
