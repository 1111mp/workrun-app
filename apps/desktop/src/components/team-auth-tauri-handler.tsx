import { useBetterAuthTauri } from '@daveyplate/better-auth-tauri/react';
import { useCallback, useMemo } from 'react';
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
