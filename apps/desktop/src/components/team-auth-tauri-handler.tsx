import { useBetterAuthTauri } from '@daveyplate/better-auth-tauri/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useEffectEvent, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { createTeamAuthClient } from '@/lib/auth-client';
import { router } from '@/routes';
import { syncTeamModelSession } from '@/services/team-model-session';
import { useWorkrunStore } from '@/stores';

function TeamAuthTauriHandler() {
  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);
  return serverUrl ? (
    <ConfiguredTeamAuthTauriHandler serverUrl={serverUrl} />
  ) : null;
}

function ConfiguredTeamAuthTauriHandler({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const authClient = useMemo(
    () => createTeamAuthClient(serverUrl),
    [serverUrl],
  );

  const { data: session } = authClient.useSession();
  const notifySessionError = useEffectEvent(() => {
    toast.error(t('settings.models.teamSessionFailed'), {
      toasterId: 'global',
    });
  });
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);

  useEffect(() => {
    let active = true;
    void queryClient.cancelQueries({ queryKey: ['modelCatalog'] });
    void syncTeamModelSession(
      serverUrl,
      workspaceMode === 'team' ? (session?.session.token ?? null) : null,
    )
      .then(() => {
        if (!active) return;
        void queryClient.resetQueries({ queryKey: ['modelCatalog'] });
      })
      .catch(() => {
        if (active && workspaceMode === 'team' && session?.session.token) {
          notifySessionError();
        }
      });
    return () => {
      active = false;
      void syncTeamModelSession(serverUrl, null).catch(() => {});
    };
  }, [serverUrl, workspaceMode, session?.session.token, queryClient]);

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
