import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Spinner,
  Switch,
  Textarea,
} from '@workspace/ui/components';
import {
  BookOpenIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  createSkill,
  deleteSkill,
  inspectSkill,
  listSkills,
  openSkillDirectory,
  openSkillFolder,
  updateSkill,
  type SkillDetails,
  type SkillWriteRequest,
} from '@/services/skill';

const emptyDraft = (): SkillWriteRequest => ({
  name: '',
  description: '',
  version: '',
  license: '',
  compatibility: '',
  tags: '',
  allowedTools: '',
  references: '',
  trigger: false,
  hint: '',
  metadata: '',
  instructions: '',
});

function SkillsPage() {
  const [draft, setDraft] = useState<SkillWriteRequest>(emptyDraft);
  const [editing, setEditing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deletingName, setDeletingName] = useState<string>();

  const { t } = useTranslation();

  const queryClient = useQueryClient();

  const skills = useQuery({ queryKey: ['skills'], queryFn: listSkills });
  const skillCount = skills.data?.length ?? 0;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['skills'] });

  const saveSkill = useMutation({
    mutationFn: (request: SkillWriteRequest) =>
      editing ? updateSkill(request) : createSkill(request),
    onSuccess: () => {
      void refresh();
      setEditorOpen(false);
      toast.success(t('settings.skills.saved'), { toasterId: 'global' });
    },
    onError: () =>
      toast.error(t('settings.skills.saveFailed'), { toasterId: 'global' }),
  });

  const removeSkill = useMutation({
    mutationFn: deleteSkill,
    onSuccess: () => {
      void refresh();
      setDeletingName(undefined);
      toast.success(t('settings.skills.deleted'), { toasterId: 'global' });
    },
    onError: () =>
      toast.error(t('settings.skills.deleteFailed'), { toasterId: 'global' }),
  });

  const openCreate = () => {
    setDraft(emptyDraft());
    setEditing(false);
    setEditorOpen(true);
  };

  const openDirectory = async (name?: string) => {
    try {
      await (name ? openSkillFolder(name) : openSkillDirectory());
    } catch (error) {
      toast.error(t('settings.skills.openDirectoryFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const openEdit = async (name: string) => {
    try {
      const skill = await inspectSkill(name);
      setDraft(toWriteRequest(skill));
      setEditing(true);
      setEditorOpen(true);
    } catch {
      toast.error(t('settings.skills.loadFailed'), { toasterId: 'global' });
    }
  };

  return (
    <div className='size-full overflow-y-auto'>
      <div className='mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8'>
        <section className='via-card relative overflow-hidden rounded-2xl border border-sky-200/70 bg-linear-to-br from-sky-500/12 to-violet-500/10 shadow-sm dark:border-sky-400/15'>
          <div className='pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(214_90%_60%/0.14)_1px,transparent_1px),linear-gradient(to_bottom,hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[28px_28px]' />
          <div className='relative flex flex-col gap-6 p-5 sm:p-7 lg:flex-row lg:items-end lg:justify-between'>
            <div className='max-w-xl'>
              <div className='text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium tracking-[0.16em] uppercase'>
                <BookOpenIcon className='size-3.5' />
                {t('settings.skills.registry')}
              </div>
              <h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
                {t('settings.skills.title')}
              </h1>
              <p className='text-muted-foreground mt-2 text-sm leading-6'>
                {t('settings.skills.description')}
              </p>
            </div>
            <div className='flex flex-col gap-3 sm:flex-row sm:items-center'>
              <div className='bg-background/70 flex divide-x divide-sky-200/70 rounded-xl border border-sky-200/70 shadow-xs backdrop-blur-sm dark:divide-sky-400/15 dark:border-sky-400/15'>
                <div className='px-4 py-2.5'>
                  <div className='text-muted-foreground text-[11px] font-medium tracking-wide uppercase'>
                    {t('settings.skills.available')}
                  </div>
                  <div className='mt-0.5 text-sm font-semibold tabular-nums'>
                    {skillCount}
                  </div>
                </div>
              </div>
              <Button
                onClick={() => void openDirectory()}
                type='button'
                variant='outline'
              >
                <FolderOpenIcon data-icon='inline-start' />
                {t('settings.skills.openDirectory')}
              </Button>
              <Button onClick={openCreate} type='button'>
                <PlusIcon data-icon='inline-start' />
                {t('settings.skills.create')}
              </Button>
            </div>
          </div>
        </section>

        <div>
          <h2 className='text-sm font-semibold'>
            {t('settings.skills.yourSkills')}
          </h2>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {t('settings.skills.yourSkillsDescription')}
          </p>
        </div>
        {skills.isPending ? (
          <div className='text-muted-foreground bg-card flex items-center gap-2 rounded-xl border px-4 py-8 text-sm'>
            <Spinner />
            {t('settings.skills.loading')}
          </div>
        ) : skills.data?.length ? (
          <div className='grid gap-3'>
            {skills.data.map((skill) => (
              <Card
                key={skill.name}
                className='group overflow-hidden border-l-4 border-l-sky-400/60 bg-sky-500/4.5 shadow-none transition-colors hover:bg-sky-500/7.5 dark:border-l-sky-400/40'
              >
                <CardContent className='grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5'>
                  <div className='min-w-0'>
                    <div className='flex items-start gap-3'>
                      <div className='flex size-9 shrink-0 items-center justify-center rounded-lg border border-sky-200/70 bg-sky-500/12 text-sky-700 dark:border-sky-400/15 dark:text-sky-300'>
                        <BookOpenIcon className='size-4.5' />
                      </div>
                      <div className='min-w-0'>
                        <CardTitle className='text-sm'>{skill.name}</CardTitle>
                        <CardDescription className='mt-1 line-clamp-2'>
                          {skill.description}
                        </CardDescription>
                      </div>
                    </div>
                    {skill.allowedTools.length > 0 && (
                      <div className='mt-3 flex flex-wrap gap-1'>
                        {skill.allowedTools.map((tool) => (
                          <Badge key={tool} variant='secondary'>
                            {tool}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className='flex items-center justify-end gap-2 border-t pt-3 sm:border-t-0 sm:pt-0'>
                    <Button
                      aria-label={t('settings.skills.openDirectory')}
                      onClick={() => void openDirectory(skill.name)}
                      size='sm'
                      type='button'
                      variant='ghost'
                    >
                      <FolderOpenIcon data-icon='inline-start' />
                      {t('settings.skills.openDirectory')}
                    </Button>
                    <Button
                      size='sm'
                      onClick={() => void openEdit(skill.name)}
                      type='button'
                      variant='ghost'
                    >
                      <PencilIcon data-icon='inline-start' />
                      {t('settings.skills.edit')}
                    </Button>
                    <Button
                      aria-label={t('settings.skills.delete')}
                      onClick={() => setDeletingName(skill.name)}
                      size='icon-sm'
                      type='button'
                      variant='ghost'
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Empty className='via-card border border-dashed border-sky-200/70 bg-linear-to-br from-sky-500/6 to-violet-500/5 py-14 dark:border-sky-400/15'>
            <EmptyHeader>
              <EmptyMedia variant='icon' className='rounded-xl'>
                <BookOpenIcon />
              </EmptyMedia>
              <EmptyTitle>{t('settings.skills.emptyTitle')}</EmptyTitle>
              <EmptyDescription>
                {t('settings.skills.emptyDescription')}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={openCreate} type='button' variant='outline'>
                <PlusIcon data-icon='inline-start' />
                {t('settings.skills.create')}
              </Button>
            </EmptyContent>
          </Empty>
        )}
        <SkillEditor
          draft={draft}
          editing={editing}
          onChange={setDraft}
          onOpenChange={setEditorOpen}
          onSave={() => saveSkill.mutate(draft)}
          open={editorOpen}
          saving={saveSkill.isPending}
        />
      </div>
      <AlertDialog
        open={Boolean(deletingName)}
        onOpenChange={(open) => !open && setDeletingName(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.skills.deleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.skills.deleteDescription', { name: deletingName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={removeSkill.isPending}
              onClick={() => deletingName && removeSkill.mutate(deletingName)}
              variant='destructive'
            >
              {t('settings.skills.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SkillEditor({
  draft,
  editing,
  onChange,
  onOpenChange,
  onSave,
  open,
  saving,
}: {
  draft: SkillWriteRequest;
  editing: boolean;
  onChange: (draft: SkillWriteRequest) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  open: boolean;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const update = (patch: Partial<SkillWriteRequest>) =>
    onChange({ ...draft, ...patch });
  const metadataIsValid = isMetadataValid(draft.metadata);
  const valid = Boolean(
    draft.name.trim() && draft.description.trim() && metadataIsValid,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='max-w-3xl! gap-0 overflow-hidden p-0'
        showCloseButton={!saving}
      >
        <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/12 to-violet-500/10 px-6 py-6 pr-14'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.16)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
          <div className='relative flex items-start gap-3'>
            <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
              <BookOpenIcon className='size-5' />
            </div>
            <div className='min-w-0'>
              <DialogTitle className='text-lg'>
                {t(
                  editing
                    ? 'settings.skills.editTitle'
                    : 'settings.skills.createTitle',
                )}
              </DialogTitle>
              <DialogDescription className='mt-1 max-w-xl leading-5'>
                {t('settings.skills.editorDescription')}
              </DialogDescription>
              <a
                className='mt-3 inline-flex items-center gap-1 text-xs font-medium text-sky-700 underline underline-offset-4 transition-colors hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100'
                href='https://agentskills.io'
                rel='noreferrer'
                target='_blank'
              >
                {t('settings.skills.learnSpecification')}
                <ExternalLinkIcon className='size-3' />
              </a>
            </div>
          </div>
        </DialogHeader>
        <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
          <FieldGroup className='gap-7'>
            <div className='flex items-start gap-3 rounded-xl border border-sky-500/20 bg-sky-500/6 p-4'>
              <div className='bg-background/70 flex size-8 shrink-0 items-center justify-center rounded-lg border border-sky-500/15 text-sky-700 dark:text-sky-300'>
                <FolderOpenIcon className='size-4' />
              </div>
              <div>
                <p className='text-sm font-medium'>
                  {t('settings.skills.resourceFolderTitle')}
                </p>
                <p className='text-muted-foreground mt-1 text-xs leading-5'>
                  {t('settings.skills.resourceFolderDescription')}
                </p>
              </div>
            </div>
            <FieldSet>
              <FieldLegend>{t('settings.skills.details')}</FieldLegend>
              <FieldGroup className='gap-5'>
                <Field>
                  <FieldLabel htmlFor='skill-name'>
                    {t('settings.skills.name')}
                  </FieldLabel>
                  <Input
                    disabled={editing}
                    id='skill-name'
                    onChange={(event) => update({ name: event.target.value })}
                    value={draft.name}
                  />
                  <FieldDescription>
                    {t('settings.skills.nameDescription')}
                  </FieldDescription>
                  {editing && (
                    <FieldDescription>
                      {t('settings.skills.nameFixed')}
                    </FieldDescription>
                  )}
                </Field>
                <Field>
                  <FieldLabel htmlFor='skill-description'>
                    {t('settings.skills.skillDescription')}
                  </FieldLabel>
                  <Textarea
                    className='min-h-20 resize-y'
                    id='skill-description'
                    onChange={(event) =>
                      update({ description: event.target.value })
                    }
                    value={draft.description}
                  />
                  <FieldDescription>
                    {t('settings.skills.skillDescriptionDescription')}
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldSet>
              <FieldLegend>{t('settings.skills.governance')}</FieldLegend>
              <FieldGroup className='gap-5'>
                <Field>
                  <FieldLabel htmlFor='skill-version'>
                    {t('settings.skills.version')}
                  </FieldLabel>
                  <Input
                    id='skill-version'
                    placeholder='1.0.0'
                    onChange={(event) =>
                      update({ version: event.target.value })
                    }
                    value={draft.version}
                  />
                  <FieldDescription>
                    {t('settings.skills.versionDescription')}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor='skill-license'>
                    {t('settings.skills.license')}
                  </FieldLabel>
                  <Input
                    id='skill-license'
                    placeholder='MIT'
                    onChange={(event) =>
                      update({ license: event.target.value })
                    }
                    value={draft.license}
                  />
                  <FieldDescription>
                    {t('settings.skills.licenseDescription')}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor='skill-compatibility'>
                    {t('settings.skills.compatibility')}
                  </FieldLabel>
                  <Input
                    id='skill-compatibility'
                    onChange={(event) =>
                      update({ compatibility: event.target.value })
                    }
                    value={draft.compatibility}
                  />
                  <FieldDescription>
                    {t('settings.skills.compatibilityDescription')}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor='skill-tags'>
                    {t('settings.skills.tags')}
                  </FieldLabel>
                  <Input
                    id='skill-tags'
                    onChange={(event) => update({ tags: event.target.value })}
                    placeholder='support voice'
                    value={draft.tags}
                  />
                  <FieldDescription>
                    {t('settings.skills.tagsDescription')}
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldSet className='bg-muted/20 rounded-xl border p-4 sm:p-5'>
              <FieldLegend>{t('settings.skills.capabilities')}</FieldLegend>
              <FieldGroup className='gap-5'>
                <Field>
                  <FieldLabel htmlFor='skill-allowed-tools'>
                    {t('settings.skills.allowedTools')}
                  </FieldLabel>
                  <Input
                    id='skill-allowed-tools'
                    onChange={(event) =>
                      update({ allowedTools: event.target.value })
                    }
                    placeholder='search read_file'
                    value={draft.allowedTools}
                  />
                  <FieldDescription>
                    {t('settings.skills.allowedToolsDescription')}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor='skill-references'>
                    {t('settings.skills.references')}
                  </FieldLabel>
                  <Textarea
                    className='min-h-20 font-mono text-xs'
                    id='skill-references'
                    onChange={(event) =>
                      update({ references: event.target.value })
                    }
                    placeholder={
                      'references/technicians.json\nreferences/coverage.csv'
                    }
                    value={draft.references}
                  />
                  <FieldDescription>
                    {t('settings.skills.referencesDescription')}
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldSet>
              <FieldLegend>{t('settings.skills.activation')}</FieldLegend>
              <FieldGroup className='gap-4'>
                <Field
                  orientation='horizontal'
                  className='bg-background rounded-xl border p-4'
                >
                  <Switch
                    checked={draft.trigger}
                    id='skill-trigger'
                    onCheckedChange={(trigger) => update({ trigger })}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor='skill-trigger'>
                      {t('settings.skills.trigger')}
                    </FieldLabel>
                    <FieldDescription>
                      {t('settings.skills.triggerDescription')}
                    </FieldDescription>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor='skill-hint'>
                    {t('settings.skills.hint')}
                  </FieldLabel>
                  <Input
                    id='skill-hint'
                    onChange={(event) => update({ hint: event.target.value })}
                    value={draft.hint}
                  />
                  <FieldDescription>
                    {t('settings.skills.hintDescription')}
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldSet>
              <FieldLegend>{t('settings.skills.metadata')}</FieldLegend>
              <Field data-invalid={!metadataIsValid || undefined}>
                <Textarea
                  aria-invalid={!metadataIsValid}
                  className='min-h-28 font-mono text-xs leading-5'
                  id='skill-metadata'
                  onChange={(event) => update({ metadata: event.target.value })}
                  placeholder={'{\n  "owner": "platform"\n}'}
                  value={draft.metadata}
                />
                <FieldDescription>
                  {metadataIsValid
                    ? t('settings.skills.metadataDescription')
                    : t('settings.skills.metadataInvalid')}
                </FieldDescription>
              </Field>
            </FieldSet>
            <FieldSet>
              <FieldLegend>{t('settings.skills.instructions')}</FieldLegend>
              <Field>
                <Textarea
                  className='min-h-64 font-mono text-xs leading-5'
                  id='skill-instructions'
                  onChange={(event) =>
                    update({ instructions: event.target.value })
                  }
                  value={draft.instructions}
                />
                <FieldDescription>
                  {t('settings.skills.instructionsDescription')}
                </FieldDescription>
              </Field>
            </FieldSet>
          </FieldGroup>
        </div>
        <DialogFooter>
          <Button disabled={saving || !valid} onClick={onSave} type='button'>
            {saving && <Spinner data-icon='inline-start' />}
            {t('settings.skills.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toWriteRequest(skill: SkillDetails): SkillWriteRequest {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    license: skill.license,
    compatibility: skill.compatibility,
    tags: skill.tags.join(' '),
    allowedTools: skill.allowedTools.join(' '),
    references: skill.references.join('\n'),
    trigger: skill.trigger,
    hint: skill.hint,
    metadata: formatMetadata(skill.metadata),
    instructions: skill.instructions,
  };
}

function formatMetadata(metadata: Record<string, unknown>) {
  return Object.keys(metadata).length ? JSON.stringify(metadata, null, 2) : '';
}

function isMetadataValid(metadata?: string) {
  if (!metadata?.trim()) return true;

  try {
    const value: unknown = JSON.parse(metadata);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

export { SkillsPage as Component };
