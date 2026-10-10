import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@workspace/ui/components';
import {
  CircleAlertIcon,
  DownloadIcon,
  FileIcon,
  UploadIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import {
  exportApp,
  importApp,
  previewAppExport,
  previewAppImport,
  type AppShareFormat,
} from '@/services/app-share';
import type { ProcessNode } from '@/services/process-node';

function shareError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function AppImportButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<string>();
  const [name, setName] = useState('');
  const [imported, setImported] = useState<ProcessNode>();
  const preview = useMutation({
    mutationFn: async () => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'App ZIP / TAR', extensions: ['zip', 'tar'] }],
      });
      if (!selected) return;
      const result = await previewAppImport(selected);
      setPath(selected);
      setName(result.app.name);
      setImported(undefined);
      return result;
    },
    onError: (error) =>
      toast.error(t('apps.share.previewFailed'), {
        toasterId: 'global',
        description: shareError(error),
      }),
  });
  const importing = useMutation({
    mutationFn: () => importApp(path!, preview.data!.sha256!, name),
    onSuccess: async (node) => {
      setImported(node);
      await queryClient.invalidateQueries({ queryKey: ['apps'] });
      toast.success(t('apps.share.imported'), { toasterId: 'global' });
    },
  });
  const preparation = useMutation({
    mutationFn: async () => {
      // Honor the imported project's Python version through the same native helper as App runs.
      await invoke('app_share_prepare', { id: imported!.definition.id });
    },
    onSuccess: () =>
      toast.success(t('apps.share.prepared'), { toasterId: 'global' }),
  });
  const busy = importing.isPending || preparation.isPending;
  const error = importing.error ?? preparation.error;
  return (
    <>
      <Button
        variant='outline'
        size='sm'
        disabled={preview.isPending}
        onClick={() => {
          importing.reset();
          preparation.reset();
          preview.mutate();
        }}
      >
        {preview.isPending ? (
          <Spinner data-icon='inline-start' />
        ) : (
          <UploadIcon data-icon='inline-start' />
        )}
        {t('apps.share.import')}
      </Button>
      <AlertDialog
        open={Boolean(preview.data)}
        onOpenChange={(next) => {
          if (!next && !busy) preview.reset();
        }}
      >
        <AlertDialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl! gap-0 overflow-y-auto p-0'>
          <div className='via-background relative overflow-hidden border-b bg-linear-to-br from-violet-500/12 to-sky-500/10 px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
            <div className='absolute -top-12 -right-10 size-36 rounded-full bg-violet-500/10 blur-2xl' />
            <AlertDialogHeader className='relative grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-3 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
              <AlertDialogMedia className='mb-0 size-10 rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-700 shadow-sm dark:text-violet-300'>
                <UploadIcon className='size-5' />
              </AlertDialogMedia>
              <div className='flex min-w-0 flex-col gap-1.5'>
                <AlertDialogTitle className='text-lg font-semibold tracking-tight'>
                  {t(
                    imported ? 'apps.share.imported' : 'apps.share.importTitle',
                  )}
                </AlertDialogTitle>
                <AlertDialogDescription className='text-sm leading-5'>
                  {t(
                    imported
                      ? 'apps.share.prepareDescription'
                      : 'apps.share.importDescription',
                  )}
                </AlertDialogDescription>
              </div>
            </AlertDialogHeader>
          </div>
          <div className='flex flex-col gap-5 px-5 py-5 sm:px-6'>
            {preview.data ? (
              <>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor='import-app-name'>
                      {t('apps.share.name')}
                    </FieldLabel>
                    <Input
                      id='import-app-name'
                      value={name}
                      disabled={Boolean(imported) || busy}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                </FieldGroup>
                <p className='text-muted-foreground text-sm'>
                  {preview.data.app.description}
                </p>
                <div className='flex flex-wrap items-center gap-2'>
                  <Badge variant='secondary'>
                    {t(
                      preview.data.app.kind === 'tool'
                        ? 'apps.toolApp'
                        : 'apps.app',
                    )}
                  </Badge>
                  <Badge variant='outline'>v{preview.data.app.version}</Badge>
                  <span className='text-muted-foreground text-xs'>
                    Workrun {preview.data.manifest.workrunVersion}
                  </span>
                </div>
                <FieldSet className='gap-3'>
                  <FieldLegend
                    variant='label'
                    className='mb-0 flex w-full flex-wrap items-center justify-between gap-2'
                  >
                    <span>{t('apps.share.sourceFiles')}</span>
                    <span className='text-muted-foreground text-xs font-normal'>
                      {t('apps.share.fileCount', {
                        count: preview.data.files.length,
                      })}{' '}
                      · {(preview.data.totalBytes / 1024).toFixed(1)} KB
                    </span>
                  </FieldLegend>
                  <div className='max-h-52 overflow-y-auto rounded-lg border'>
                    {preview.data.files.map((file) => (
                      <div
                        key={file}
                        className='flex items-start gap-2.5 border-b px-3 py-2.5 last:border-b-0'
                      >
                        <FileIcon className='text-muted-foreground mt-0.5 size-3.5 shrink-0' />
                        <span className='min-w-0 font-mono text-xs break-all'>
                          {file}
                        </span>
                      </div>
                    ))}
                  </div>
                </FieldSet>
              </>
            ) : null}
            {error ? (
              <Alert variant='destructive'>
                <CircleAlertIcon />
                <AlertDescription>{shareError(error)}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter className='mx-0 mb-0 px-5 py-4 sm:px-6'>
            {imported ? (
              <>
                <AlertDialogCancel disabled={busy}>
                  {t('apps.share.close')}
                </AlertDialogCancel>
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={() => navigate(`/apps/${imported.definition.id}`)}
                >
                  {t('apps.details')}
                </Button>
                <Button
                  disabled={busy || preparation.isSuccess}
                  onClick={() => preparation.mutate()}
                >
                  {preparation.isPending ? (
                    <Spinner data-icon='inline-start' />
                  ) : null}
                  {t(
                    preparation.isSuccess
                      ? 'apps.share.prepared'
                      : 'apps.share.prepare',
                  )}
                </Button>
              </>
            ) : (
              <>
                <AlertDialogCancel disabled={busy}>
                  {t('apps.share.cancel')}
                </AlertDialogCancel>
                <Button
                  disabled={busy || !name.trim()}
                  onClick={() => importing.mutate()}
                >
                  {importing.isPending ? (
                    <Spinner data-icon='inline-start' />
                  ) : null}
                  {t('apps.share.import')}
                </Button>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function AppExportButton({
  id,
  disabled,
  compact = false,
}: {
  id: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const controlId = useId();
  const [opened, setOpened] = useState(false);
  const [format, setFormat] = useState<AppShareFormat>('zip');
  const [excluded, setExcluded] = useState<string[]>([]);
  const preview = useQuery({
    queryKey: ['app-share-export', id],
    queryFn: () => previewAppExport(id),
    enabled: opened,
  });
  const exporting = useMutation({
    mutationFn: async () => {
      const safeName = (preview.data?.app.name ?? 'app').replace(
        /[\\/:*?"<>|]/g,
        '_',
      );
      const destination = await save({
        defaultPath: `${safeName}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!destination) return false;
      await exportApp(id, destination, format, excluded, preview.data!.files);
      return true;
    },
    onSuccess: (saved) => {
      if (saved) {
        setOpened(false);
        toast.success(t('apps.share.exported'), { toasterId: 'global' });
      }
    },
  });
  return (
    <>
      <Button
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'icon-sm' : 'default'}
        aria-label={t('apps.share.export')}
        title={t('apps.share.export')}
        disabled={disabled}
        onClick={() => {
          setExcluded([]);
          exporting.reset();
          setOpened(true);
        }}
      >
        <DownloadIcon data-icon={compact ? undefined : 'inline-start'} />
        {!compact ? t('apps.share.export') : null}
      </Button>
      <AlertDialog
        open={opened}
        onOpenChange={(next) => {
          if (!exporting.isPending) setOpened(next);
        }}
      >
        <AlertDialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl! gap-0 overflow-y-auto p-0'>
          <div className='via-background relative overflow-hidden border-b bg-linear-to-br from-violet-500/12 to-sky-500/10 px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
            <div className='absolute -top-12 -right-10 size-36 rounded-full bg-violet-500/10 blur-2xl' />
            <AlertDialogHeader className='relative grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-3 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
              <AlertDialogMedia className='mb-0 size-10 rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-700 shadow-sm dark:text-violet-300'>
                <DownloadIcon className='size-5' />
              </AlertDialogMedia>
              <div className='flex min-w-0 flex-col gap-1.5'>
                <AlertDialogTitle className='text-lg font-semibold tracking-tight'>
                  {t('apps.share.exportTitle')}
                </AlertDialogTitle>
                <AlertDialogDescription className='max-w-md text-sm leading-5'>
                  {t('apps.share.exportDescription')}
                </AlertDialogDescription>
              </div>
            </AlertDialogHeader>
          </div>
          <div className='flex flex-col gap-5 px-5 py-5 sm:px-6'>
            {preview.data ? (
              <div className='flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2.5'>
                <div className='flex min-w-0 flex-col gap-0.5'>
                  <span
                    className='truncate text-sm font-medium'
                    title={preview.data.app.name}
                  >
                    {preview.data.app.name}
                  </span>
                  <span className='text-muted-foreground text-xs'>
                    v{preview.data.app.version}
                  </span>
                </div>
                <Badge variant='secondary'>
                  {t(
                    preview.data.app.kind === 'tool'
                      ? 'apps.toolApp'
                      : 'apps.app',
                  )}
                </Badge>
              </div>
            ) : null}
            <FieldGroup className='gap-5'>
              <Field>
                <FieldLabel htmlFor={`${controlId}-format`}>
                  {t('apps.share.format')}
                </FieldLabel>
                <Select
                  items={[
                    { value: 'zip', label: 'ZIP' },
                    { value: 'tar', label: 'TAR' },
                  ]}
                  value={format}
                  disabled={exporting.isPending}
                  onValueChange={(value) => {
                    if (value === 'zip' || value === 'tar') setFormat(value);
                  }}
                >
                  <SelectTrigger id={`${controlId}-format`} className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value='zip'>ZIP</SelectItem>
                      <SelectItem value='tar'>TAR</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {t('apps.share.savedSettingsHint')}
                </FieldDescription>
              </Field>
              {preview.data ? (
                <FieldSet className='gap-3'>
                  <FieldLegend
                    variant='label'
                    className='mb-0 flex w-full items-center justify-between gap-3'
                  >
                    <span>{t('apps.share.sourceFiles')}</span>
                    <span className='text-muted-foreground text-xs'>
                      {t('apps.share.fileCount', {
                        count: preview.data.files.filter(
                          (file) => !excluded.includes(file),
                        ).length,
                      })}
                    </span>
                  </FieldLegend>
                  <FieldDescription>
                    {t('apps.share.filesHint')}
                  </FieldDescription>
                  <FieldGroup className='max-h-52 gap-0 overflow-y-auto rounded-lg border'>
                    {preview.data.files.map((file, index) => {
                      const required =
                        file === preview.data.app.entry ||
                        file === preview.data.app.compensation?.entry ||
                        file === 'pyproject.toml';
                      const fileId = `${controlId}-file-${index}`;
                      return (
                        <Field
                          key={file}
                          orientation='horizontal'
                          data-disabled={required || exporting.isPending}
                          className='gap-2.5 border-b px-3 py-2.5 last:border-b-0'
                        >
                          <Checkbox
                            id={fileId}
                            checked={!excluded.includes(file)}
                            disabled={required || exporting.isPending}
                            onCheckedChange={(checked) =>
                              setExcluded((current) =>
                                checked
                                  ? current.filter((path) => path !== file)
                                  : [...current, file],
                              )
                            }
                          />
                          <FileIcon className='text-muted-foreground size-3.5 shrink-0' />
                          <FieldLabel
                            htmlFor={fileId}
                            className='min-w-0 flex-1 font-mono text-xs font-normal break-all'
                          >
                            {file}
                          </FieldLabel>
                          {required ? (
                            <Badge variant='outline'>
                              {t('apps.share.requiredFile')}
                            </Badge>
                          ) : null}
                        </Field>
                      );
                    })}
                  </FieldGroup>
                </FieldSet>
              ) : null}
            </FieldGroup>
            {preview.isPending ? (
              <div
                role='status'
                className='text-muted-foreground flex items-center gap-2 text-sm'
              >
                <Spinner />
                {t('apps.share.loadingFiles')}
              </div>
            ) : null}
            {preview.error || exporting.error ? (
              <Alert variant='destructive'>
                <CircleAlertIcon />
                <AlertDescription>
                  {shareError(preview.error ?? exporting.error)}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter className='mx-0 mb-0 px-5 py-4 sm:px-6'>
            <AlertDialogCancel disabled={exporting.isPending}>
              {t('apps.share.cancel')}
            </AlertDialogCancel>
            <Button
              disabled={
                !preview.isSuccess || preview.isFetching || exporting.isPending
              }
              onClick={() => exporting.mutate()}
            >
              {exporting.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <DownloadIcon data-icon='inline-start' />
              )}
              {t('apps.share.export')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
