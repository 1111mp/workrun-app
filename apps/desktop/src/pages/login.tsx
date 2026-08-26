import { signInSocial } from '@daveyplate/better-auth-tauri';
import { SiGithub, SiGoogle } from '@icons-pack/react-simple-icons';
import { Button, Input, Label, Spinner } from '@workspace/ui/components';
import { type SubmitEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { AuthPageLayout } from '@/components/auth-page-layout';
import { createTeamAuthClient } from '@/lib/auth-client';
import { getTeamUser } from '@/services/session';
import { useWorkrunStore } from '@/stores';

function LoginPage() {
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState<boolean>(false);
  const [startingProvider, setStartingProvider] = useState<string>();

  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);

  const navigate = useNavigate();

  const { t } = useTranslation();
  const isAuthenticating = saving || Boolean(startingProvider);

  const login = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!serverUrl) return;

    setSaving(true);
    setError(undefined);
    try {
      const authClient = createTeamAuthClient(serverUrl);
      const result = await authClient.signIn.email({
        email,
        password,
      });
      if (result.error || !(await getTeamUser(serverUrl))) {
        throw new Error('Login failed');
      }
      void navigate('/workflows', { replace: true });
    } catch {
      setError(t('onboarding.login.failed'));
    } finally {
      setSaving(false);
    }
  };

  const startOAuth = async (provider: 'github' | 'google' | 'feishu') => {
    if (!serverUrl) return;

    setStartingProvider(provider);
    setError(undefined);
    try {
      const authClient = createTeamAuthClient(serverUrl);
      const result = await signInSocial({
        authClient,
        callbackURL: import.meta.env.DEV ? 'http://localhost:1420' : undefined,
        provider,
      });
      if (result.error) throw result.error;
    } catch {
      setError(t('onboarding.login.oauthStartFailed'));
      setStartingProvider(undefined);
    }
  };

  if (!serverUrl) {
    return (
      <AuthPageLayout
        description={t('onboarding.login.missingServerDescription')}
        title={t('onboarding.login.missingServerTitle')}
      >
        <Button onClick={() => void navigate('/settings')}>
          {t('onboarding.login.openWorkspaceSettings')}
        </Button>
      </AuthPageLayout>
    );
  }

  return (
    <>
      <AuthPageLayout
        description={t('onboarding.login.description', { serverUrl })}
        title={t('onboarding.login.title')}
      >
        <div className='space-y-3'>
          <Button
            className='w-full'
            disabled={isAuthenticating}
            onClick={() => void startOAuth('github')}
            type='button'
            variant='outline'
          >
            <SiGithub />
            {startingProvider === 'github'
              ? t('onboarding.login.openingBrowser')
              : t('onboarding.login.continueWithGithub')}
          </Button>
          <div className='grid grid-cols-2 gap-3'>
            <Button disabled type='button' variant='outline'>
              <SiGoogle />
              {t('onboarding.login.google')}
            </Button>
            <Button disabled type='button' variant='outline'>
              <img alt='' aria-hidden className='size-4' src='/lark.svg' />
              {t('onboarding.login.feishu')}
            </Button>
          </div>
          <p className='text-muted-foreground text-center text-xs'>
            {t('onboarding.login.moreProvidersSoon')}
          </p>
        </div>
        <div className='relative my-6'>
          <div className='border-border absolute inset-0 top-1/2 border-t' />
          <span className='bg-background text-muted-foreground relative mx-auto block w-fit px-3 text-xs'>
            {t('onboarding.login.orContinueWithEmail')}
          </span>
        </div>
        <form className='space-y-4' onSubmit={(event) => void login(event)}>
          <div className='space-y-2'>
            <Label htmlFor='team-email'>{t('onboarding.login.email')}</Label>
            <Input
              autoFocus
              disabled={isAuthenticating}
              id='team-email'
              onChange={(event) => setEmail(event.target.value)}
              required
              type='email'
              value={email}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='team-password'>
              {t('onboarding.login.password')}
            </Label>
            <Input
              disabled={isAuthenticating}
              id='team-password'
              onChange={(event) => setPassword(event.target.value)}
              required
              type='password'
              value={password}
            />
          </div>
          <div className='flex justify-between gap-3'>
            <Button
              disabled={isAuthenticating}
              onClick={() => void navigate('/settings')}
              type='button'
              variant='ghost'
            >
              {t('onboarding.login.openWorkspaceSettings')}
            </Button>
            <Button disabled={isAuthenticating} type='submit'>
              {saving ? '…' : t('onboarding.login.submit')}
            </Button>
          </div>
        </form>
        {error ? (
          <p className='text-destructive mt-4 text-sm'>{error}</p>
        ) : null}
      </AuthPageLayout>
      {isAuthenticating ? (
        <div
          aria-busy
          aria-live='polite'
          className='bg-background/70 fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm'
          role='status'
        >
          <div className='bg-background/90 flex w-full max-w-xs flex-col items-center gap-3 rounded-xl border p-6 text-center shadow-lg'>
            <Spinner className='text-primary size-5' />
            <p className='text-sm font-medium'>
              {startingProvider
                ? t('onboarding.login.openingBrowser')
                : t('onboarding.login.signingIn')}
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}

export { LoginPage as Component };
