import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Input,
  Label,
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
    if (!displayName.trim()) return;
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

  if (workspaceMode === 'team') {
    return (
      <div className='size-full overflow-y-auto'>
        <main className='mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6'>
          <section className='bg-card rounded-2xl border p-5 shadow-sm sm:p-6'>
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
                  <h1 className='text-xl font-semibold tracking-tight'>
                    {t('profile.team.title')}
                  </h1>
                  <span className='bg-primary/10 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium'>
                    <Building2Icon className='size-3' />
                    {t('profile.team.badge')}
                  </span>
                </div>
                <p className='text-muted-foreground mt-1 text-sm'>
                  {t('profile.team.description')}
                </p>
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
      <main className='mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6'>
        <section className='bg-card rounded-2xl border p-5 shadow-sm sm:p-6'>
          <h1 className='text-xl font-semibold tracking-tight'>
            {t('profile.title')}
          </h1>
          <p className='text-muted-foreground mt-1 text-sm'>
            {t('profile.description')}
          </p>
          <div className='mt-6 space-y-6'>
            <div className='space-y-2'>
              <Label htmlFor='profile-display-name'>{t('profile.name')}</Label>
              <Input
                id='profile-display-name'
                maxLength={80}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t('profile.namePlaceholder')}
                value={displayName}
              />
            </div>
            <div className='space-y-3'>
              <Label>{t('profile.avatar')}</Label>
              <div className='flex flex-wrap gap-3'>
                {AVATAR_IDS.map((id, index) => (
                  <button
                    aria-label={t('profile.avatarOption', {
                      number: index + 1,
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
            <Button
              disabled={!displayName.trim() || saving}
              onClick={() => void save()}
            >
              {saving ? '…' : t('profile.save')}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}

export { ProfilePage as Component };
