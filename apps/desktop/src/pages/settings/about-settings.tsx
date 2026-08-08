import { check } from '@tauri-apps/plugin-updater';
import {
  FieldGroup,
  FieldLegend,
  FieldSet,
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
  Separator,
  Spinner,
} from '@workspace/ui/components';
import { ChevronRightIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { getAppVersion } from '@/services/api';
import { useUpdaterStore } from '@/stores';

function AboutSettings() {
  const [version, setVersion] = useState<string>('');

  const { t } = useTranslation();

  useEffect(() => {
    void getAppVersion().then(setVersion);
  }, []);

  return (
    <FieldSet>
      <FieldLegend className='text-muted-foreground pl-3'>
        {t('settings.about.title')}
      </FieldLegend>
      <div className='overflow-hidden rounded-xl'>
        <FieldGroup className='gap-0'>
          <CheckForUpdatesItem />
          <Separator />
          <Item
            variant='muted'
            size='sm'
            className='hover:bg-muted rounded-none py-3'
            onClick={async () => {
              await navigator.clipboard.writeText(version);
              toast.success(t('settings.about.versionCopied'));
            }}
          >
            <ItemContent>
              <ItemTitle>Synclan {t('settings.about.version')}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <span className='text-muted-foreground'>v{version}</span>
              <ChevronRightIcon className='size-4' />
            </ItemActions>
          </Item>
        </FieldGroup>
      </div>
    </FieldSet>
  );
}

function CheckForUpdatesItem() {
  const [loading, setLoading] = useState<boolean>(false);

  const { t } = useTranslation();

  const checkForUpdates = async () => {
    if (loading) return;

    setLoading(true);
    try {
      const update = await check();
      if (update) {
        const store = useUpdaterStore.getState();
        store.setUpdate(update);
        store.setOpen(true);
      } else {
        toast.success(t('updater.upToDate'));
      }
    } catch {
      toast.error(t('updater.failedToCheck'), {
        description: t('updater.checkFailedDescription'),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Item
      variant='muted'
      size='sm'
      className='hover:bg-muted rounded-none py-3'
      onClick={checkForUpdates}
    >
      <ItemContent>
        <ItemTitle>{t('settings.about.checkForUpdates')}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <span className='text-muted-foreground'>
          {t('settings.about.checkNow')}
        </span>
        {loading ? <Spinner /> : <ChevronRightIcon className='size-4' />}
      </ItemActions>
    </Item>
  );
}

export { AboutSettings };
