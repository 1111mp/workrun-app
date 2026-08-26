import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  FieldLegend,
  Input,
  Item,
  ItemContent,
  ItemTitle,
} from '@workspace/ui/components';
import { HardDriveIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { createTeamAuthClient } from '@/lib/auth-client';
import { normalizeServerUrl } from '@/services/session';
import { useWorkrunStore } from '@/stores';

function WorkspaceSettings() {
  const { t } = useTranslation();
  const config = useWorkrunStore((s) => s.config);
  const updateConfig = useWorkrunStore((s) => s.updateConfig);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<WorkspaceMode>(
    config?.workspace_mode ?? 'personal',
  );
  const [serverUrl, setServerUrl] = useState(config?.team?.server_url ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (mode === 'team' && !normalizeServerUrl(serverUrl)) {
      toast.error(t('settings.workspace.invalidServerUrl'), {
        toasterId: 'global',
      });
      return;
    }

    setSaving(true);
    try {
      const currentMode = config?.workspace_mode ?? 'personal';
      const currentServerUrl = config?.team?.server_url;

      if (currentMode === 'team' && mode === 'personal') {
        if (currentServerUrl) {
          const result = await createTeamAuthClient(currentServerUrl).signOut();
          if (result.error) throw result.error;
        }
        useWorkrunStore.getState().setTeamUser(undefined);
        queryClient.removeQueries({ queryKey: ['team-user'] });
      }

      await updateConfig({
        workspace_mode: mode,
        ...(mode === 'team'
          ? { team: { server_url: normalizeServerUrl(serverUrl)! } }
          : {}),
      });
      toast.success(t('settings.workspace.saved'), { toasterId: 'global' });

      if (currentMode === 'team' && mode === 'personal') {
        await navigate('/profile', { replace: true });
        return;
      }

      if (currentMode === 'personal' && mode === 'team') {
        useWorkrunStore.getState().setTeamUser(undefined);
        queryClient.removeQueries({ queryKey: ['team-user'] });
        await navigate('/login', { replace: true });
      }
    } catch {
      toast.error(t('settings.workspace.signOutFailed'), {
        toasterId: 'global',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <FieldLegend className='text-muted-foreground'>
        {t('settings.workspace.title')}
      </FieldLegend>
      <p className='text-muted-foreground mt-1 text-sm'>
        {t('settings.workspace.description')}
      </p>
      <div className='mt-4 grid gap-3 sm:grid-cols-2'>
        <ModeOption
          active={mode === 'personal'}
          description={t('settings.workspace.personalDescription')}
          icon={HardDriveIcon}
          onClick={() => setMode('personal')}
          title={t('settings.workspace.personal')}
        />
        <ModeOption
          active={mode === 'team'}
          description={t('settings.workspace.teamDescription')}
          icon={UsersIcon}
          onClick={() => setMode('team')}
          title={t('settings.workspace.team')}
        />
      </div>
      {mode === 'team' ? (
        <div className='mt-4 space-y-2'>
          <label className='text-sm font-medium' htmlFor='team-server-url'>
            {t('settings.workspace.serverUrl')}
          </label>
          <Input
            id='team-server-url'
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder='https://workrun.example.com'
            type='url'
            value={serverUrl}
          />
        </div>
      ) : null}
      <Button className='mt-4' disabled={saving} onClick={() => void save()}>
        {saving ? '…' : t('settings.workspace.save')}
      </Button>
    </div>
  );
}

function ModeOption({
  active,
  description,
  icon: Icon,
  onClick,
  title,
}: {
  active: boolean;
  description: string;
  icon: typeof HardDriveIcon;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      className={
        active
          ? 'border-primary bg-primary/5 ring-primary rounded-xl border text-left ring-1'
          : 'hover:bg-muted/50 rounded-xl border text-left transition-colors'
      }
      onClick={onClick}
      type='button'
    >
      <Item className='py-3'>
        <Icon className='text-primary size-4' />
        <ItemContent>
          <ItemTitle>{title}</ItemTitle>
          <p className='text-muted-foreground mt-0.5 text-sm'>{description}</p>
        </ItemContent>
      </Item>
    </button>
  );
}

export { WorkspaceSettings };
