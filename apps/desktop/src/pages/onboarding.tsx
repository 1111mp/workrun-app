import {
  Avatar,
  AvatarImage,
  Button,
  Card,
  Input,
  Label,
} from '@workspace/ui/components';
import { ArrowLeftIcon, HardDriveIcon, UsersIcon } from 'lucide-react';
import { type SubmitEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthPageLayout } from '@/components/auth-page-layout';
import { localProfileAvatarUrl } from '@/lib/avatar';
import { router } from '@/routes';
import {
  getTeamUser,
  normalizeServerUrl,
  type TeamUser,
} from '@/services/session';
import { useWorkrunStore } from '@/stores';

const AVATAR_IDS = [
  'workrun-01',
  'workrun-02',
  'workrun-03',
  'workrun-04',
  'workrun-05',
  'workrun-06',
  'workrun-07',
  'workrun-08',
];
function OnboardingPage() {
  const config = useWorkrunStore((s) => s.config);
  const [mode, setMode] = useState<WorkspaceMode | null | undefined>(
    config?.workspace_mode,
  );

  const updateConfig = useWorkrunStore((s) => s.updateConfig);

  const { t } = useTranslation();

  const selectedMode = mode ?? config?.workspace_mode;

  if (!config) return null;

  if (!selectedMode) {
    return (
      <AuthPageLayout
        description={t('onboarding.description')}
        title={t('onboarding.title')}
      >
        <div className='grid gap-4 md:grid-cols-2'>
          <ModeCard
            action={t('onboarding.personal.action')}
            description={t('onboarding.personal.description')}
            icon={HardDriveIcon}
            onSelect={() => setMode('personal')}
            title={t('onboarding.personal.title')}
          />
          <ModeCard
            action={t('onboarding.team.action')}
            description={t('onboarding.team.description')}
            icon={UsersIcon}
            onSelect={() => setMode('team')}
            title={t('onboarding.team.title')}
          />
        </div>
      </AuthPageLayout>
    );
  }

  return selectedMode === 'personal' ? (
    <PersonalProfileStep
      initialProfile={config.local_profile}
      onBack={() => setMode(undefined)}
      onComplete={(profile) =>
        updateConfig({
          workspace_mode: 'personal',
          local_profile: profile,
          onboarding_completed: true,
        })
      }
    />
  ) : (
    <TeamSetupStep
      initialServerUrl={config.team?.server_url}
      onBack={() => setMode(undefined)}
      onComplete={async (serverUrl, teamUser) => {
        if (!teamUser) {
          await router.navigate('/login');
        }
        await updateConfig({
          workspace_mode: 'team',
          team: { server_url: serverUrl },
          onboarding_completed: true,
        });
      }}
    />
  );
}

function PersonalProfileStep({
  initialProfile,
  onBack,
  onComplete,
}: {
  initialProfile?: LocalProfile;
  onBack: () => void;
  onComplete: (profile: LocalProfile) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(
    initialProfile?.display_name ?? '',
  );
  const [avatarId, setAvatarId] = useState(
    initialProfile?.avatar_id ?? AVATAR_IDS[0],
  );
  const [saving, setSaving] = useState(false);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!displayName.trim()) return;
    setSaving(true);
    try {
      await onComplete({
        display_name: displayName.trim(),
        avatar_id: avatarId,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AuthPageLayout
      description={t('onboarding.profile.description')}
      title={t('onboarding.profile.title')}
    >
      <form className='space-y-6' onSubmit={(event) => void submit(event)}>
        <div className='space-y-2'>
          <Label htmlFor='display-name'>{t('onboarding.profile.name')}</Label>
          <Input
            autoFocus
            id='display-name'
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={t('onboarding.profile.namePlaceholder')}
            required
            value={displayName}
          />
        </div>
        <div className='space-y-3'>
          <Label>{t('onboarding.profile.avatar')}</Label>
          <div className='flex gap-3'>
            {AVATAR_IDS.map((id) => (
              <button
                aria-label={t('onboarding.profile.avatarOption', {
                  number: AVATAR_IDS.indexOf(id) + 1,
                })}
                className={
                  avatarId === id
                    ? 'ring-primary ring-offset-background rounded-full ring-2 ring-offset-2'
                    : 'rounded-full opacity-70 transition-opacity hover:opacity-100'
                }
                key={id}
                onClick={() => setAvatarId(id)}
                type='button'
              >
                <Avatar className='size-12'>
                  <AvatarImage alt='' src={localProfileAvatarUrl(id)} />
                </Avatar>
              </button>
            ))}
          </div>
        </div>
        <StepActions
          backLabel={t('onboarding.back')}
          onBack={onBack}
          saving={saving}
          submitLabel={t('onboarding.profile.continue')}
        />
      </form>
    </AuthPageLayout>
  );
}

function TeamSetupStep({
  initialServerUrl,
  onBack,
  onComplete,
}: {
  initialServerUrl?: string;
  onBack: () => void;
  onComplete: (serverUrl: string, teamUser: TeamUser | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState(initialServerUrl ?? '');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const normalizedUrl = useMemo(
    () => normalizeServerUrl(serverUrl),
    [serverUrl],
  );

  const checkServer = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!normalizedUrl) {
      setError(t('onboarding.team.invalidUrl'));
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      await onComplete(normalizedUrl, await getTeamUser(normalizedUrl));
    } catch {
      setError(t('onboarding.team.unreachable'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AuthPageLayout
      description={t('onboarding.team.setupDescription')}
      title={t('onboarding.team.setupTitle')}
    >
      <form className='space-y-6' onSubmit={(event) => void checkServer(event)}>
        <div className='space-y-2'>
          <Label htmlFor='server-url'>{t('onboarding.team.serverUrl')}</Label>
          <Input
            autoFocus
            id='server-url'
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder='https://workrun.example.com'
            required
            type='url'
            value={serverUrl}
          />
          <p className='text-muted-foreground text-sm'>
            {t('onboarding.team.serverUrlHint')}
          </p>
          {error ? <p className='text-destructive text-sm'>{error}</p> : null}
        </div>
        <StepActions
          backLabel={t('onboarding.back')}
          onBack={onBack}
          saving={saving}
          submitLabel={t('onboarding.team.connect')}
        />
      </form>
    </AuthPageLayout>
  );
}

function ModeCard({
  action,
  description,
  icon: Icon,
  onSelect,
  title,
}: {
  action: string;
  description: string;
  icon: typeof HardDriveIcon;
  onSelect: () => void;
  title: string;
}) {
  return (
    <Card className='gap-6 p-2 transition-shadow hover:shadow-md'>
      <div className='px-4 pt-4'>
        <div className='bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg'>
          <Icon className='size-5' />
        </div>
      </div>
      <div className='flex flex-1 flex-col justify-between gap-6 px-4 pb-4'>
        <div>
          <h2 className='text-lg font-medium'>{title}</h2>
          <p className='text-muted-foreground mt-2 leading-6'>{description}</p>
        </div>
        <Button className='w-full' onClick={onSelect}>
          {action}
        </Button>
      </div>
    </Card>
  );
}

function StepActions({
  backLabel,
  onBack,
  saving,
  submitLabel,
}: {
  backLabel: string;
  onBack: () => void;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <div className='flex justify-between gap-3'>
      <Button disabled={saving} onClick={onBack} type='button' variant='ghost'>
        <ArrowLeftIcon />
        {backLabel}
      </Button>
      <Button disabled={saving} type='submit'>
        {saving ? '…' : submitLabel}
      </Button>
    </div>
  );
}

export { OnboardingPage };
