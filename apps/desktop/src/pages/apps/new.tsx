import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from '@workspace/ui/components';
import { ArrowLeftIcon, PencilIcon, SaveIcon } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';

import { isTeamMode } from '@/lib/constant';
import {
  createTeamProcessNodeDraft,
  createProcessNode,
  getProcessNodeDefaultRoot,
  updateProcessNode,
  type ProcessNodeCreateStage,
} from '@/services/process-node';

function createAppSchema(nameRequired: string) {
  return z.object({
    name: z.string().trim().min(1, nameRequired),
    description: z.string(),
    kind: z.enum(['workflow', 'tool']),
    projectRoot: z.string().trim(),
  });
}

type CreateProcessNodeForm = z.infer<ReturnType<typeof createAppSchema>>;

function CreateProcessNodePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createStage, setCreateStage] = useState<ProcessNodeCreateStage>();
  const { data: defaultProjectRoot } = useQuery({
    queryKey: ['apps', 'default-project-root'],
    queryFn: getProcessNodeDefaultRoot,
  });
  const form = useForm<CreateProcessNodeForm>({
    resolver: zodResolver(createAppSchema(t('apps.new.nameRequired'))),
    defaultValues: {
      name: '',
      description: '',
      kind: 'workflow',
      projectRoot: '',
    },
  });

  const create = useMutation({
    mutationFn: async (request: CreateProcessNodeForm) => {
      const node = await createProcessNode(
        { ...request, projectRoot: request.projectRoot || undefined },
        (progress) => setCreateStage(progress.stage),
      );
      if (!isTeamMode()) return node;

      setCreateStage('savingApp');
      const remote = await createTeamProcessNodeDraft(node.definition);
      // The local project remains the authoring source, while this ID binds
      // its server Draft to later metadata saves and releases.
      return updateProcessNode({
        ...node.definition,
        remoteAppId: remote.id,
        publicationStatus: 'draft',
      });
    },
    onMutate: () => setCreateStage('creatingProject'),
    onSuccess: (node) => {
      void queryClient.invalidateQueries({ queryKey: ['apps'] });
      toast.success(t('apps.new.created'), { toasterId: 'global' });
      void navigate(`/apps/${node.definition.id}`, { replace: true });
    },
    onError: (error) => {
      setCreateStage(undefined);
      toast.error(t('apps.new.createFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const submit = form.handleSubmit((values) => create.mutate(values));
  const stageLabel = createStage
    ? t(`apps.new.stages.${createStage}`)
    : undefined;
  const appKinds = [
    { value: 'workflow', label: t('apps.app') },
    { value: 'tool', label: t('apps.toolApp') },
  ];

  return (
    <div className='size-full overflow-y-auto'>
      <main className='mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6'>
        <section className='via-background relative overflow-hidden rounded-2xl border bg-linear-to-br from-sky-500/10 to-violet-500/8 p-5 shadow-sm sm:p-6'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[16px_16px]' />
          <div className='flex min-w-0 items-center gap-3'>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={t('apps.new.backToApps')}
              onClick={() => navigate('/apps')}
            >
              <ArrowLeftIcon />
            </Button>
            <div className='relative'>
              <div className='text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase'>
                {t('apps.new.localProject')}
              </div>
              <h1 className='mt-1 text-xl font-semibold tracking-tight'>
                {t('apps.new.title')}
              </h1>
              <p className='text-muted-foreground mt-1 text-sm'>
                {t('apps.new.description')}
              </p>
            </div>
          </div>
        </section>

        <Card className='shadow-sm'>
          <CardHeader>
            <CardTitle>{t('apps.new.detailsTitle')}</CardTitle>
            <CardDescription>
              {t('apps.new.detailsDescription')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form id='form-create-app' onSubmit={submit}>
              <FieldGroup className='gap-6'>
                <Controller
                  name='name'
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor='app-name'>
                        {t('apps.new.name')}
                      </FieldLabel>
                      <Input
                        {...field}
                        id='app-name'
                        placeholder={t('apps.new.namePlaceholder')}
                        aria-invalid={fieldState.invalid}
                        autoComplete='off'
                      />
                      {fieldState.invalid ? (
                        <FieldError errors={[fieldState.error]} />
                      ) : null}
                    </Field>
                  )}
                />
                <Controller
                  name='description'
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor='app-description'>
                        {t('apps.new.fieldDescription')}
                      </FieldLabel>
                      <Textarea
                        {...field}
                        id='app-description'
                        placeholder={t('apps.new.descriptionPlaceholder')}
                        aria-invalid={fieldState.invalid}
                      />
                      {fieldState.invalid ? (
                        <FieldError errors={[fieldState.error]} />
                      ) : null}
                    </Field>
                  )}
                />
                <Controller
                  name='kind'
                  control={form.control}
                  render={({ field }) => (
                    <Field>
                      <FieldLabel htmlFor='app-kind'>
                        {t('apps.new.appType')}
                      </FieldLabel>
                      <FieldDescription>
                        {t('apps.new.appTypeDescription')}
                      </FieldDescription>
                      <Select
                        items={appKinds}
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger id='app-kind' className='w-full'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {appKinds.map((kind) => (
                            <SelectItem key={kind.value} value={kind.value}>
                              {kind.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                />
                <Controller
                  name='projectRoot'
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel>{t('apps.new.projectRoot')}</FieldLabel>
                      <FieldDescription>
                        {t('apps.new.projectRootDescription')}
                      </FieldDescription>
                      <div className='bg-muted flex items-center rounded-md border'>
                        <span className='text-muted-foreground min-w-0 flex-1 truncate px-3 py-2 text-sm'>
                          {field.value ||
                            defaultProjectRoot ||
                            t('apps.new.loading')}
                        </span>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          className='mr-1 shrink-0'
                          aria-label={t('apps.new.changeProjectRoot')}
                          title={t('apps.new.changeProjectRoot')}
                          onClick={() => {
                            void open({
                              directory: true,
                              multiple: false,
                              title: t('apps.new.selectProjectRoot'),
                              defaultPath: field.value || defaultProjectRoot,
                            }).then((directory) => {
                              if (typeof directory === 'string') {
                                field.onChange(directory);
                              }
                            });
                          }}
                        >
                          <PencilIcon />
                        </Button>
                      </div>
                      {fieldState.invalid ? (
                        <FieldError errors={[fieldState.error]} />
                      ) : null}
                    </Field>
                  )}
                />
              </FieldGroup>
            </form>
          </CardContent>
          <CardFooter>
            <Field orientation='horizontal' className='justify-end'>
              {create.isPending && createStage ? (
                <span className='text-muted-foreground mr-auto text-sm'>
                  {stageLabel}
                </span>
              ) : null}
              <Button
                type='button'
                variant='outline'
                onClick={() => navigate('/apps')}
              >
                {t('apps.new.cancel')}
              </Button>
              <Button
                type='submit'
                form='form-create-app'
                disabled={create.isPending}
              >
                {create.isPending ? (
                  <Spinner data-icon='inline-start' />
                ) : (
                  <SaveIcon data-icon='inline-start' />
                )}
                {create.isPending && stageLabel
                  ? stageLabel
                  : t('apps.new.createProject')}
              </Button>
            </Field>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}

export { CreateProcessNodePage as Component };
