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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
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
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import type { AppShareFormat } from '@/services/app-share';
import { getModelCatalog } from '@/services/cmd';
import { listRemoteCredentials } from '@/services/remote-agent';
import { listSkills } from '@/services/skill';
import type { StoredWorkflow } from '@/services/workflow';
import {
  exportWorkflow,
  listWorkflowShareMcpTools,
  importWorkflow,
  previewWorkflowExport,
  previewWorkflowImport,
  configureImportedWorkflow,
  previewWorkflowConfiguration,
  type WorkflowShareRequirement,
  type WorkflowShareImportResult,
  type WorkflowSharePreview,
} from '@/services/workflow-share';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function PackageSummary({ preview }: { preview: WorkflowSharePreview }) {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col gap-3'>
      <p className='text-muted-foreground text-xs'>
        Workrun {preview.manifest.workrunVersion} ·{' '}
        {t('workflows.share.counts', {
          workflows: preview.manifest.workflows.length,
          apps: preview.manifest.apps.length,
        })}
      </p>
      <div className='flex max-h-36 flex-col overflow-y-auto rounded-lg border text-sm'>
        {preview.manifest.workflows.map((workflow) => (
          <p
            key={`workflow-${workflow.id}`}
            className='border-b px-3 py-2.5 last:border-b-0'
          >
            {workflow.name}
          </p>
        ))}
        {preview.manifest.apps.map((app) => (
          <p
            key={`app-${app.id}`}
            className='text-muted-foreground border-b px-3 py-2.5 last:border-b-0'
          >
            App · {app.name}
          </p>
        ))}
      </div>
      <details className='text-muted-foreground text-xs'>
        <summary className='cursor-pointer'>
          {t('workflows.share.files', { count: preview.files.length })} ·{' '}
          {(preview.totalBytes / 1024).toFixed(1)} KB
        </summary>
        <pre className='mt-2 max-h-52 overflow-auto rounded-lg border p-3'>
          {preview.files.join('\n')}
        </pre>
      </details>
    </div>
  );
}

export function WorkflowExportButton({
  id,
  disabled,
  open: controlledOpen,
  onOpenChange,
}: {
  id: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const opened = controlledOpen ?? internalOpen;
  const setOpened = onOpenChange ?? setInternalOpen;
  const [format, setFormat] = useState<AppShareFormat>('zip');
  const preview = useQuery({
    queryKey: ['workflow-share-export', id],
    queryFn: () => previewWorkflowExport(id),
    enabled: opened,
  });
  const exporting = useMutation({
    mutationFn: async () => {
      const root = preview.data!.manifest.workflows.find(
        (workflow) => workflow.id === preview.data!.manifest.entryWorkflowId,
      )!;
      const name = root.name.replace(/[\\/:*?"<>|]/g, '_');
      const destination = await save({
        defaultPath: `${name}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!destination) return false;
      await exportWorkflow(id, destination, format, preview.data!.fingerprint);
      return true;
    },
    onSuccess: (saved) => {
      if (saved) {
        setOpened(false);
        toast.success(t('workflows.share.exported'), { toasterId: 'global' });
      }
    },
  });
  return (
    <>
      {controlledOpen === undefined ? (
        <Button
          variant='outline'
          size='sm'
          disabled={disabled}
          title={disabled ? t('workflows.share.saveFirst') : undefined}
          onClick={() => {
            exporting.reset();
            setOpened(true);
          }}
        >
          <DownloadIcon data-icon='inline-start' />
          {t('workflows.share.export')}
        </Button>
      ) : null}
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
                  {t('workflows.share.export')}
                </AlertDialogTitle>
                <AlertDialogDescription className='max-w-md text-sm leading-5'>
                  {t('workflows.share.exportDescription')}
                </AlertDialogDescription>
              </div>
            </AlertDialogHeader>
          </div>
          <div className='flex flex-col gap-5 px-5 py-5 sm:px-6'>
            {preview.isPending ? (
              <div
                role='status'
                className='text-muted-foreground flex items-center gap-2 text-sm'
              >
                <Spinner />
                {t('apps.share.loadingFiles')}
              </div>
            ) : null}
            {preview.data ? (
              <>
                <div className='flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2.5'>
                  <div className='flex min-w-0 flex-col gap-0.5'>
                    <span className='truncate text-sm font-medium'>
                      {
                        preview.data.manifest.workflows.find(
                          (workflow) =>
                            workflow.id ===
                            preview.data.manifest.entryWorkflowId,
                        )?.name
                      }
                    </span>
                    <span className='text-muted-foreground text-xs'>
                      Workrun {preview.data.manifest.workrunVersion}
                    </span>
                  </div>
                  <Badge variant='secondary'>Workflow</Badge>
                </div>
                <FieldGroup className='gap-5'>
                  <Field>
                    <FieldLabel htmlFor='workflow-share-format'>
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
                        if (value === 'zip' || value === 'tar')
                          setFormat(value);
                      }}
                    >
                      <SelectTrigger
                        id='workflow-share-format'
                        className='w-full'
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value='zip'>ZIP</SelectItem>
                          <SelectItem value='tar'>TAR</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <FieldSet className='gap-3'>
                    <FieldLegend variant='label' className='mb-0'>
                      {t('workflows.share.counts', {
                        workflows: preview.data.manifest.workflows.length,
                        apps: preview.data.manifest.apps.length,
                      })}
                    </FieldLegend>
                    <div className='max-h-36 overflow-y-auto rounded-lg border'>
                      {[
                        ...preview.data.manifest.workflows.map((item) => ({
                          ...item,
                          kind: 'Workflow',
                        })),
                        ...preview.data.manifest.apps.map((item) => ({
                          ...item,
                          kind: 'App',
                        })),
                      ].map((item) => (
                        <div
                          key={`${item.kind}-${item.id}`}
                          className='flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0'
                        >
                          <span
                            className='min-w-0 truncate text-sm'
                            title={item.name}
                          >
                            {item.name}
                          </span>
                          <Badge variant='outline'>{item.kind}</Badge>
                        </div>
                      ))}
                    </div>
                  </FieldSet>
                  <FieldSet className='gap-3'>
                    <FieldLegend
                      variant='label'
                      className='mb-0 flex w-full flex-wrap items-center justify-between gap-2'
                    >
                      <span>{t('apps.share.sourceFiles')}</span>
                      <span className='text-muted-foreground text-xs font-normal'>
                        {t('workflows.share.files', {
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
                  {preview.data.manifest.requirements.length ? (
                    <FieldSet className='gap-3'>
                      <FieldLegend variant='label' className='mb-0'>
                        {t('workflows.share.externalRequirements')}
                      </FieldLegend>
                      <div className='max-h-32 overflow-y-auto rounded-lg border'>
                        {preview.data.manifest.requirements.map(
                          (requirement) => (
                            <p
                              key={requirement.id}
                              className='text-muted-foreground border-b px-3 py-2.5 text-sm last:border-b-0'
                            >
                              {t(`workflows.share.kinds.${requirement.kind}`)} ·{' '}
                              {requirement.label}
                            </p>
                          ),
                        )}
                      </div>
                    </FieldSet>
                  ) : null}
                </FieldGroup>
              </>
            ) : null}
            {preview.error || exporting.error ? (
              <Alert variant='destructive'>
                <CircleAlertIcon />
                <AlertDescription>
                  {errorMessage(preview.error ?? exporting.error)}
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
              {t('workflows.share.export')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function WorkflowImportButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<string>();
  const [name, setName] = useState('');
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [imported, setImported] = useState<WorkflowShareImportResult>();
  const [preparedIds, setPreparedIds] = useState<string[]>([]);
  const [preparingName, setPreparingName] = useState('');
  const preview = useMutation({
    mutationFn: async () => {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Workflow ZIP / TAR', extensions: ['zip', 'tar'] }],
      });
      if (!selected) return;
      const result = await previewWorkflowImport(selected);
      setPath(selected);
      setBindings(result.bindings);
      setImported(undefined);
      setPreparedIds([]);
      setName(
        result.manifest.workflows.find(
          (workflow) => workflow.id === result.manifest.entryWorkflowId,
        )!.name,
      );
      return result;
    },
    onError: (error) =>
      toast.error(t('workflows.share.previewFailed'), {
        toasterId: 'global',
        description: errorMessage(error),
      }),
  });
  const importing = useMutation({
    mutationFn: () =>
      importWorkflow(path!, preview.data!.fingerprint, name, bindings),
    onSuccess: async (result) => {
      setImported(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workflows'] }),
        queryClient.invalidateQueries({ queryKey: ['apps'] }),
      ]);
      toast.success(t('workflows.share.imported'), { toasterId: 'global' });
    },
  });
  const preparation = useMutation({
    mutationFn: async () => {
      for (const app of imported!.apps) {
        if (preparedIds.includes(app.id)) continue;
        setPreparingName(app.name);
        await invoke('app_share_prepare', { id: app.id });
        setPreparedIds((current) => [...current, app.id]);
      }
    },
    onSuccess: () =>
      toast.success(t('apps.share.prepared'), { toasterId: 'global' }),
    onSettled: () => setPreparingName(''),
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
        {t('workflows.share.import')}
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
                    imported
                      ? 'workflows.share.imported'
                      : 'workflows.share.import',
                  )}
                </AlertDialogTitle>
                <AlertDialogDescription className='text-sm leading-5'>
                  {t(
                    imported
                      ? 'workflows.share.importedDescription'
                      : 'workflows.share.importDescription',
                  )}
                </AlertDialogDescription>
              </div>
            </AlertDialogHeader>
          </div>
          <div className='flex flex-col gap-5 px-5 py-5 sm:px-6'>
            {preview.data ? (
              <>
                <PackageSummary preview={preview.data} />
                {!imported ? (
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor='workflow-import-name'>
                        {t('workflows.share.name')}
                      </FieldLabel>
                      <Input
                        id='workflow-import-name'
                        value={name}
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
                    <WorkflowBindingFields
                      requirements={preview.data.manifest.requirements}
                      bindings={bindings}
                      setBindings={setBindings}
                      busy={busy}
                    />
                  </FieldGroup>
                ) : (
                  <>
                    {imported.pending.length ? (
                      <div className='text-muted-foreground text-sm'>
                        <p>
                          {t('workflows.share.pending', {
                            count: imported.pending.length,
                          })}
                        </p>
                        {imported.pending.map((requirement) => (
                          <p key={requirement.id}>{requirement.label}</p>
                        ))}
                      </div>
                    ) : null}
                    {preparingName ? (
                      <p className='text-muted-foreground text-sm'>
                        {t('workflows.share.preparingApp', {
                          name: preparingName,
                        })}
                      </p>
                    ) : null}
                  </>
                )}
              </>
            ) : null}
            {error ? (
              <Alert variant='destructive'>
                <CircleAlertIcon />
                <AlertDescription>{errorMessage(error)}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter className='mx-0 mb-0 px-5 py-4 sm:px-6'>
            {imported ? (
              <>
                <Button
                  variant='outline'
                  disabled={busy}
                  onClick={() => navigate(`/workflows/${imported.workflow.id}`)}
                >
                  {t('workflows.share.openWorkflow')}
                </Button>
                {imported.apps.length ? (
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
                ) : null}
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
                  ) : (
                    <UploadIcon data-icon='inline-start' />
                  )}
                  {t('workflows.share.import')}
                </Button>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function WorkflowBindingFields({
  requirements,
  bindings,
  setBindings,
  busy,
}: {
  requirements: WorkflowShareRequirement[];
  bindings: Record<string, string>;
  setBindings: Dispatch<SetStateAction<Record<string, string>>>;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const models = useQuery({
    queryKey: ['modelCatalog'],
    queryFn: getModelCatalog,
    enabled: requirements.some((item) => item.kind === 'model'),
  });
  const tools = useQuery({
    queryKey: ['workflow-share-tools'],
    queryFn: listWorkflowShareMcpTools,
    enabled: Boolean(requirements.some((item) => item.kind === 'tool')),
  });
  const skills = useQuery({
    queryKey: ['workflow-share-skills'],
    queryFn: listSkills,
    enabled: Boolean(requirements.some((item) => item.kind === 'skill')),
  });
  const credentials = useQuery({
    queryKey: ['workflow-share-credentials'],
    queryFn: listRemoteCredentials,
    enabled: Boolean(requirements.some((item) => item.kind === 'credential')),
  });
  return (
    <FieldGroup>
      {requirements.length ? (
        <p className='text-muted-foreground text-xs'>
          {t('workflows.share.bindingDescription')}
        </p>
      ) : null}
      {requirements.map((requirement) => {
        const options =
          requirement.kind === 'model'
            ? models.data?.map((model) => ({
                value: model.id,
                label: model.name,
              }))
            : requirement.kind === 'tool'
              ? tools.data
                  ?.filter((tool) => tool.source === 'mcp')
                  .map((tool) => ({
                    value: tool.id,
                    label: `${tool.sourceName ?? 'MCP'} / ${tool.displayName}`,
                  }))
              : requirement.kind === 'skill'
                ? skills.data?.map((skill) => ({
                    value: skill.name,
                    label: skill.name,
                  }))
                : requirement.kind === 'credential'
                  ? credentials.data
                      ?.filter(
                        (credential) =>
                          credential.origin === requirement.origin &&
                          credential.kind === requirement.credentialKind,
                      )
                      .map((credential) => ({
                        value: credential.id,
                        label: credential.name,
                      }))
                  : undefined;
        const isSelection = ['model', 'tool', 'skill', 'credential'].includes(
          requirement.kind,
        );
        const selectionError =
          requirement.kind === 'model'
            ? models.error
            : requirement.kind === 'tool'
              ? tools.error
              : requirement.kind === 'skill'
                ? skills.error
                : credentials.error;
        const fieldId = `workflow-binding-${requirement.id}`;
        return (
          <Field key={requirement.id}>
            <FieldLabel htmlFor={fieldId}>
              {t(`workflows.share.kinds.${requirement.kind}`)} ·{' '}
              {requirement.label}
            </FieldLabel>
            {isSelection ? (
              <Select
                disabled={busy}
                value={bindings[requirement.id] || '__pending__'}
                onValueChange={(value) =>
                  setBindings((current) => ({
                    ...current,
                    [requirement.id]:
                      !value || value === '__pending__' ? '' : value,
                  }))
                }
              >
                <SelectTrigger id={fieldId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value='__pending__'>
                      {t('workflows.share.configureLater')}
                    </SelectItem>
                    {options?.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={fieldId}
                type={requirement.kind === 'environment' ? 'password' : 'text'}
                disabled={busy}
                value={bindings[requirement.id] ?? ''}
                placeholder={t('workflows.share.configureLater')}
                onChange={(event) =>
                  setBindings((current) => ({
                    ...current,
                    [requirement.id]: event.target.value,
                  }))
                }
              />
            )}
            {isSelection && selectionError ? (
              <p className='text-destructive text-xs'>
                {errorMessage(selectionError)}
              </p>
            ) : null}
          </Field>
        );
      })}
    </FieldGroup>
  );
}

export function WorkflowConfigureButton({
  id,
  disabled,
  onConfigured,
}: {
  id: string;
  disabled?: boolean;
  onConfigured: (workflow: StoredWorkflow) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const preview = useMutation({
    mutationFn: async () => {
      const result = await previewWorkflowConfiguration(id);
      setBindings(result.bindings);
      return result;
    },
    onError: (error) =>
      toast.error(t('workflows.share.previewFailed'), {
        toasterId: 'global',
        description: errorMessage(error),
      }),
  });
  const configuration = useMutation({
    mutationFn: () =>
      configureImportedWorkflow(id, preview.data!.fingerprint, bindings),
    onSuccess: async (workflow) => {
      onConfigured(workflow);
      preview.reset();
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(t('workflows.share.configured'), { toasterId: 'global' });
    },
  });
  return (
    <>
      <Button
        variant='outline'
        size='sm'
        disabled={disabled || preview.isPending}
        title={disabled ? t('workflows.share.saveFirst') : undefined}
        onClick={() => {
          configuration.reset();
          preview.mutate();
        }}
      >
        {preview.isPending ? <Spinner data-icon='inline-start' /> : null}
        {t('workflows.share.configure')}
      </Button>
      <Dialog
        open={Boolean(preview.data)}
        onOpenChange={(next) => {
          if (!next && !configuration.isPending) preview.reset();
        }}
      >
        <DialogContent
          className='max-h-[85vh] overflow-y-auto sm:max-w-xl'
          showCloseButton={!configuration.isPending}
        >
          <DialogHeader>
            <DialogTitle>{t('workflows.share.configure')}</DialogTitle>
            <DialogDescription>
              {t('workflows.share.configureDescription')}
            </DialogDescription>
          </DialogHeader>
          {preview.data ? (
            <WorkflowBindingFields
              requirements={preview.data.manifest.requirements}
              bindings={bindings}
              setBindings={setBindings}
              busy={configuration.isPending}
            />
          ) : null}
          {configuration.error ? (
            <p role='alert' className='text-destructive text-sm'>
              {errorMessage(configuration.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant='outline'
              disabled={configuration.isPending}
              onClick={() => preview.reset()}
            >
              {t('apps.share.cancel')}
            </Button>
            <Button
              disabled={configuration.isPending || !preview.data}
              onClick={() => configuration.mutate()}
            >
              {configuration.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : null}
              {t('workflows.share.saveConfiguration')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
