import { relaunch } from '@tauri-apps/plugin-process';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Field,
  FieldLabel,
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Kbd,
  Progress,
  Spinner,
} from '@workspace/ui/components';
import debounce from 'lodash-es/debounce';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-markdown';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { useUpdaterStore } from '@/stores';

function UpdateDialog() {
  const [downloading, setDownloading] = useState<boolean>(false);
  const [downloaded, setDownloaded] = useState<boolean>(false);
  const [installing, setInstalling] = useState<boolean>(false);
  const [percentage, setPercentage] = useState<number>();

  const { t } = useTranslation();

  const { open, update } = useUpdaterStore(
    useShallow((s) => ({
      open: s.open,
      update: s.update,
    })),
  );

  const downloadUpdate = async () => {
    if (update === null) return;

    setDownloading(true);
    setDownloaded(false);

    let downloaded: number = 0;
    let total: number = 0;
    const updateProgress = debounce(
      (downloaded: number, contentLength: number) => {
        if (contentLength > 0) {
          setPercentage(Math.floor((downloaded / contentLength) * 100));
        }
      },
      100,
    );

    try {
      await update.download((progress) => {
        switch (progress.event) {
          case 'Started':
            total = progress.data.contentLength ?? 0;
            break;

          case 'Progress':
            downloaded += progress.data.chunkLength;
            updateProgress(downloaded, total);
            break;

          case 'Finished':
            setPercentage(100);
            break;
        }
      });

      setDownloading(false);
      setDownloaded(true);
    } catch {
      toast.error(t('updater.downloadFailed'), {
        toasterId: 'global',
        description: t('updater.checkFailedDescription'),
      });
      setDownloading(false);
    }
  };

  const installUpdate = async () => {
    if (!update) return;

    try {
      setInstalling(true);

      await update.install();
      await relaunch();
    } catch {
      toast.error(t('updater.installFailed'), {
        toasterId: 'global',
      });
      setInstalling(false);
    }
  };

  const hasUpdate = update !== null;

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className='max-w-xl!'>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Info />
          </AlertDialogMedia>
          <AlertDialogTitle>{t('updater.updateInfo')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('updater.updateDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div>
          {hasUpdate && (
            <>
              <ItemGroup className='grid grid-cols-2 gap-4'>
                <Item>
                  <ItemContent>
                    <ItemTitle>{t('updater.currentVersion')}</ItemTitle>
                    <ItemDescription>{update.currentVersion}</ItemDescription>
                  </ItemContent>
                </Item>
                <Item>
                  <ItemContent>
                    <ItemTitle>{t('updater.newVersion')}</ItemTitle>
                    <ItemDescription>{update.version}</ItemDescription>
                  </ItemContent>
                </Item>
              </ItemGroup>
              <Item>
                <ItemContent>
                  <ItemTitle>{t('updater.releaseNotes')}</ItemTitle>
                  <div className='bg-muted text-muted-foreground mt-2 max-h-50 overflow-auto rounded-sm p-3'>
                    <Markdown
                      components={{
                        a: ({ children, ...props }) => {
                          return (
                            <a
                              className='text-primary underline'
                              {...props}
                              target='_blank'
                            >
                              {children}
                            </a>
                          );
                        },
                        h3: ({ children }) => (
                          <h3 className='text-base font-bold'>{children}</h3>
                        ),
                        ul: ({ children }) => (
                          <ul className='px-6 py-2'>{children}</ul>
                        ),
                        li: ({ children }) => (
                          <li className='list-disc text-sm leading-6'>
                            {children}
                          </li>
                        ),
                        code: ({ children }) => (
                          <Kbd className='text-card-foreground bg-card'>
                            {children}
                          </Kbd>
                        ),
                      }}
                    >
                      {update.body}
                    </Markdown>
                  </div>
                </ItemContent>
              </Item>
            </>
          )}
          {percentage !== undefined && (
            <Field className='w-full px-3 py-2'>
              <FieldLabel htmlFor='progress-upload'>
                <span>{t('updater.downloadProgress')}</span>
                <span className='ml-auto'>{percentage}%</span>
              </FieldLabel>
              <Progress value={percentage} id='progress-upload' />
            </Field>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={async () => {
              setDownloading(false);
              setDownloaded(false);
              setPercentage(undefined);

              useUpdaterStore.getState().setOpen(false);
              useUpdaterStore.getState().setUpdate(null);

              if (update) {
                await update.close();
              }
            }}
          >
            {t('confirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!hasUpdate || downloading || installing}
            onClick={async () => {
              if (downloaded) {
                await installUpdate();
              } else {
                await downloadUpdate();
              }
            }}
          >
            {(downloading || installing) && <Spinner />}
            {downloaded ? t('updater.quitAndInstall') : t('updater.update')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { UpdateDialog };
