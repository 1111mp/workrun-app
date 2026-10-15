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
      <AlertDialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl! gap-0 overflow-y-auto p-0'>
        <div className='via-background relative overflow-hidden border-b bg-linear-to-br from-violet-500/12 to-sky-500/10 px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
          <div className='absolute -top-12 -right-10 size-36 rounded-full bg-violet-500/10 blur-2xl' />
          <AlertDialogHeader className='relative grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-3 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
            <AlertDialogMedia className='mb-0 size-10 rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-700 shadow-sm dark:text-violet-300'>
              <Info className='size-5' />
            </AlertDialogMedia>
            <div className='flex min-w-0 flex-col gap-1.5'>
              <AlertDialogTitle className='text-lg font-semibold tracking-tight'>
                {t('updater.updateInfo')}
              </AlertDialogTitle>
              <AlertDialogDescription className='text-sm leading-5'>
                {t('updater.updateDescription')}
              </AlertDialogDescription>
            </div>
          </AlertDialogHeader>
        </div>
        <div className='flex flex-col gap-5 px-5 py-5 sm:px-6'>
          {hasUpdate && (
            <>
              <ItemGroup className='grid grid-cols-2 gap-3'>
                <Item variant='outline' className='min-w-0'>
                  <ItemContent>
                    <ItemTitle>{t('updater.currentVersion')}</ItemTitle>
                    <ItemDescription>{update.currentVersion}</ItemDescription>
                  </ItemContent>
                </Item>
                <Item variant='outline' className='min-w-0'>
                  <ItemContent>
                    <ItemTitle>{t('updater.newVersion')}</ItemTitle>
                    <ItemDescription>{update.version}</ItemDescription>
                  </ItemContent>
                </Item>
              </ItemGroup>
              <ItemGroup>
                <Item className='p-0'>
                  <ItemContent>
                    <ItemTitle>{t('updater.releaseNotes')}</ItemTitle>
                    <div className='bg-muted/40 text-muted-foreground mt-2 max-h-64 overflow-auto rounded-lg border p-4 text-sm leading-6 wrap-break-word'>
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
              </ItemGroup>
            </>
          )}
          {percentage !== undefined && (
            <Field className='w-full'>
              <FieldLabel htmlFor='progress-upload'>
                <span>{t('updater.downloadProgress')}</span>
                <span className='ml-auto'>{percentage}%</span>
              </FieldLabel>
              <Progress value={percentage} id='progress-upload' />
            </Field>
          )}
        </div>
        <AlertDialogFooter className='mx-0 mb-0 px-5 py-4 sm:px-6'>
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
