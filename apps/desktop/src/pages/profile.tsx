import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Input,
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
  Spinner,
} from '@workspace/ui/components';
import { Building2Icon, SettingsIcon, UserIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { localProfileAvatarUrl } from '@/lib/avatar';
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

function ProfilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);
  const teamUser = useWorkrunStore((s) => s.teamUser);
  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);
  const profile = useWorkrunStore((s) => s.config?.local_profile);
  const updateConfig = useWorkrunStore((s) => s.updateConfig);
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [avatarId, setAvatarId] = useState(profile?.avatar_id ?? AVATAR_IDS[0]);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!displayName.trim() || saving) return;
    setSaving(true);
    try {
      await updateConfig({
        local_profile: {
          display_name: displayName.trim(),
          avatar_id: avatarId,
        },
      });
      toast.success(t('profile.saved'), { toasterId: 'global' });
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <section className='via-background relative overflow-hidden rounded-2xl border bg-linear-to-br from-sky-500/10 to-violet-500/8 p-5 shadow-sm sm:p-6'>
      <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[16px_16px]' />
      <div className='relative'>
        <div className='text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase'>
          Workrun
        </div>
        <h1 className='mt-1 text-xl font-semibold tracking-tight'>
          {t(workspaceMode === 'team' ? 'profile.team.title' : 'profile.title')}
        </h1>
        <p className='text-muted-foreground mt-1 text-sm'>
          {t(
            workspaceMode === 'team'
              ? 'profile.team.description'
              : 'profile.description',
          )}
        </p>
      </div>
    </section>
  );

  if (workspaceMode === 'team') {
    return (
      <div className='size-full overflow-y-auto'>
        <main className='mx-auto flex min-h-full max-w-4xl flex-col gap-6 px-6 py-6'>
          {header}
          <section className='bg-card rounded-2xl border p-4 shadow-sm sm:p-5'>
            <div className='flex items-start gap-4'>
              <Avatar className='size-14'>
                {teamUser?.image ? (
                  <AvatarImage alt={teamUser.name} src={teamUser.image} />
                ) : null}
                <AvatarFallback>
                  <UserIcon className='size-6' />
                </AvatarFallback>
              </Avatar>
              <div className='min-w-0 flex-1'>
                <div className='flex flex-wrap items-center gap-2'>
                  <h2 className='text-base font-medium'>
                    {teamUser?.name ?? t('profile.team.title')}
                  </h2>
                  <Badge variant='secondary'>
                    <Building2Icon data-icon='inline-start' />
                    {t('profile.team.badge')}
                  </Badge>
                </div>
              </div>
            </div>

            <dl className='mt-6 divide-y rounded-xl border px-4'>
              <div className='flex items-center justify-between gap-4 py-3'>
                <dt className='text-muted-foreground text-sm'>
                  {t('profile.team.name')}
                </dt>
                <dd className='truncate text-sm font-medium'>
                  {teamUser?.name ?? '—'}
                </dd>
              </div>
              <div className='flex items-center justify-between gap-4 py-3'>
                <dt className='text-muted-foreground text-sm'>
                  {t('profile.team.email')}
                </dt>
                <dd className='truncate text-sm font-medium'>
                  {teamUser?.email ?? '—'}
                </dd>
              </div>
              <div className='flex items-center justify-between gap-4 py-3'>
                <dt className='text-muted-foreground text-sm'>
                  {t('profile.team.server')}
                </dt>
                <dd className='truncate text-sm font-medium'>
                  {serverUrl ?? '—'}
                </dd>
              </div>
            </dl>

            <Button
              className='mt-5'
              onClick={() => navigate('/settings')}
              variant='outline'
            >
              <SettingsIcon />
              {t('profile.team.workspaceSettings')}
            </Button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className='size-full overflow-y-auto'>
      <main className='mx-auto flex min-h-full max-w-4xl flex-col gap-6 px-6 py-6'>
        {header}
        <section className='bg-card rounded-2xl border p-4 shadow-sm sm:p-5'>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor='profile-display-name'>
                  {t('profile.name')}
                </FieldLabel>
                <Input
                  id='profile-display-name'
                  maxLength={80}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={t('profile.namePlaceholder')}
                  value={displayName}
                />
              </Field>
              <FieldSet>
                <FieldLegend variant='label'>{t('profile.avatar')}</FieldLegend>
                <div className='flex flex-wrap gap-3'>
                  {AVATAR_IDS.map((id, index) => (
                    <button
                      aria-pressed={avatarId === id}
                      aria-label={t('profile.avatarOption', {
                        number: index + 1,
                      })}
                      className={
                        avatarId === id
                          ? 'ring-primary ring-offset-background focus-visible:outline-ring rounded-full ring-2 ring-offset-2 focus-visible:outline-2 focus-visible:outline-offset-4'
                          : 'focus-visible:outline-ring rounded-full opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-4'
                      }
                      key={id}
                      onClick={() => setAvatarId(id)}
                      type='button'
                    >
                      <Avatar className='size-12'>
                        <AvatarImage alt='' src={localProfileAvatarUrl(id)} />
                        <AvatarFallback>
                          <UserIcon />
                        </AvatarFallback>
                      </Avatar>
                    </button>
                  ))}
                </div>
              </FieldSet>
              <div className='flex justify-end border-t pt-5'>
                <Button type='submit' disabled={!displayName.trim() || saving}>
                  {saving ? <Spinner data-icon='inline-start' /> : null}
                  {t('profile.save')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </section>
      </main>
    </div>
  );
}

export { ProfilePage as Component };
