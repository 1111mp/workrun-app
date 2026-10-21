import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Skeleton,
  Spinner,
} from '@workspace/ui/components';
import {
  FilePenLineIcon,
  EyeIcon,
  GitBranchIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { WorkflowImportButton } from '@/components/workflow-share-dialog';
import { isTeamMode } from '@/lib/constant';
import {
  clearLegacyWorkflowDocument,
  createWorkflow,
  getWorkflows,
  loadLegacyWorkflowDocument,
  type StoredWorkflow,
} from '@/services/workflow';

function WorkflowCard({
  workflow,
  readOnly = false,
}: {
  workflow: StoredWorkflow;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { settings } = workflow.document;
  const inputCount = settings.inputSchema.fields.length;
  return (
    <Card size='sm' className='workrun-library-card h-full'>
      <CardHeader className='workrun-library-card-header'>
        <div className='flex min-w-0 items-center gap-3'>
          <div className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300'>
            <WorkflowIcon className='size-4' />
          </div>
          <CardTitle className='line-clamp-2 min-w-0' title={settings.name}>
            {settings.name}
          </CardTitle>
        </div>
        <CardDescription className='line-clamp-2 min-h-10'>
          {settings.description || t('workflows.noDescription')}
        </CardDescription>
        <CardAction>
          <div className='flex items-center gap-1'>
            {workflow.latestRelease ? (
              <Badge variant='secondary'>
                v{workflow.latestRelease.version}
              </Badge>
            ) : (
              <Badge variant='outline'>{t('workflows.draft')}</Badge>
            )}
            <Badge variant='secondary' className='capitalize'>
              {t(`workflows.modes.${settings.mode}`)}
            </Badge>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className='flex-1'>
        <div className='workrun-workflow-metrics grid grid-cols-3 overflow-hidden rounded-lg text-xs'>
          <div className='flex flex-col gap-1 p-2.5'>
            <WorkflowIcon className='size-3.5 text-violet-600 dark:text-violet-400' />
            <span className='text-foreground font-medium'>
              {workflow.document.nodes.length}
            </span>
            <span className='text-muted-foreground'>
              {t('workflows.nodes')}
            </span>
          </div>
          <div className='border-border flex flex-col gap-1 border-x p-2.5'>
            <GitBranchIcon className='size-3.5 text-violet-600 dark:text-violet-400' />
            <span className='text-foreground font-medium'>
              {workflow.document.edges.length}
            </span>
            <span className='text-muted-foreground'>
              {t('workflows.connections')}
            </span>
          </div>
          <div className='flex flex-col gap-1 p-2.5'>
            <SlidersHorizontalIcon className='size-3.5 text-violet-600 dark:text-violet-400' />
            <span className='text-foreground font-medium'>{inputCount}</span>
            <span className='text-muted-foreground'>
              {t('workflows.inputs')}
            </span>
          </div>
        </div>
      </CardContent>
      <CardFooter className='gap-2'>
        <span className='text-muted-foreground text-xs'>
          {t('workflows.canvas')}
        </span>
        <div className='ml-auto flex items-center gap-1.5'>
          <Button
            size='sm'
            nativeButton={false}
            render={
              <Link
                to={
                  readOnly
                    ? `/workflows/${workflow.id}?catalog=true&run=true`
                    : `/workflows/${workflow.id}?run=true`
                }
              />
            }
          >
            <PlayIcon data-icon='inline-start' />
            {t('workflows.run')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            nativeButton={false}
            render={
              <Link
                to={`/workflows/${workflow.id}${readOnly ? '?catalog=true' : ''}`}
                viewTransition
              />
            }
          >
            {readOnly ? (
              <EyeIcon data-icon='inline-start' />
            ) : (
              <FilePenLineIcon data-icon='inline-start' />
            )}
            {readOnly ? t('workflows.view') : t('workflows.edit')}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

function WorkflowListSkeleton() {
  return (
    <div className='workrun-library-grid grid gap-4'>
      {Array.from({ length: 3 }, (_, index) => (
        <Card key={index} size='sm'>
          <CardHeader>
            <Skeleton className='h-4 w-36' />
            <Skeleton className='h-4 w-full' />
          </CardHeader>
          <CardContent>
            <Skeleton className='h-4 w-32' />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function WorkflowsPage() {
  const [query, setQuery] = useState<string>('');

  const queryClient = useQueryClient();

  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: getWorkflows,
  });

  const migrateLegacy = useMutation({
    mutationFn: createWorkflow,
    onSuccess: () => {
      clearLegacyWorkflowDocument();
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(t('workflows.legacyMigrated'), {
        toasterId: 'global',
      });
    },
  });

  const { t } = useTranslation();

  useEffect(() => {
    if (
      workflows.data?.length ||
      migrateLegacy.isPending ||
      migrateLegacy.isError
    )
      return;
    const legacy = loadLegacyWorkflowDocument();
    if (legacy) migrateLegacy.mutate(legacy);
  }, [migrateLegacy, t, workflows.data]);

  const filteredWorkflows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return workflows.data;
    return workflows.data?.filter((workflow) =>
      [
        workflow.document.settings.name,
        workflow.document.settings.description,
        workflow.id,
      ].some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }, [query, workflows.data]);

  return (
    <div className='workrun-library size-full overflow-y-auto'>
      <main className='mx-auto flex w-full max-w-400 flex-col gap-5 px-5 py-6 lg:px-8'>
        <div className='flex flex-col gap-2'>
          <div className='flex flex-wrap items-baseline gap-3'>
            <h1 className='text-2xl font-semibold tracking-tight'>
              {t('workflows.title')}
            </h1>
            <span className='text-muted-foreground text-xs'>
              {t('workflows.localCount', {
                count: workflows.data?.length ?? '—',
              })}
            </span>
          </div>
          <p className='text-muted-foreground max-w-2xl text-sm leading-relaxed'>
            {t('workflows.libraryDescription')}
          </p>
        </div>
        <section className='workrun-library-toolbar flex min-w-0 flex-wrap items-center gap-2.5'>
          <InputGroup className='w-full sm:mr-auto sm:w-64'>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('workflows.searchPlaceholder')}
              aria-label={t('workflows.searchLabel')}
            />
          </InputGroup>
          <Button
            variant='outline'
            size='sm'
            disabled={workflows.isFetching}
            onClick={() => void workflows.refetch()}
          >
            {workflows.isFetching ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <RefreshCwIcon data-icon='inline-start' />
            )}
            {t('workflows.refresh')}
          </Button>
          {!isTeamMode() ? <WorkflowImportButton /> : null}
          <Button
            size='sm'
            nativeButton={false}
            render={<Link to='/workflows/new' viewTransition />}
          >
            <PlusIcon data-icon='inline-start' />
            {t('workflows.create')}
          </Button>
        </section>
        {workflows.isLoading || migrateLegacy.isPending ? (
          <WorkflowListSkeleton />
        ) : null}
        {filteredWorkflows?.length ? (
          <section className='workrun-library-grid grid gap-4'>
            {filteredWorkflows.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                readOnly={workflow.editable === false}
              />
            ))}
          </section>
        ) : null}
        {workflows.isError ? (
          <Empty className='via-card border border-dashed border-violet-200/70 bg-linear-to-br from-violet-500/6 to-sky-500/5 py-14 dark:border-violet-400/15'>
            <EmptyHeader>
              <EmptyTitle>{t('workflows.loadErrorTitle')}</EmptyTitle>
              <EmptyDescription>
                {workflows.error instanceof Error
                  ? workflows.error.message
                  : t('workflows.loadErrorDescription')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {!workflows.isLoading &&
        !migrateLegacy.isPending &&
        !workflows.data?.length ? (
          <Empty className='via-card border border-dashed border-sky-200/70 bg-linear-to-br from-sky-500/6 to-violet-500/5 py-14 dark:border-sky-400/15'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>{t('workflows.emptyTitle')}</EmptyTitle>
              <EmptyDescription>
                {t('workflows.emptyDescription')}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                nativeButton={false}
                render={<Link to='/workflows/new' />}
              >
                <PlusIcon data-icon='inline-start' />
                {t('workflows.create')}
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
        {workflows.data?.length && filteredWorkflows?.length === 0 ? (
          <Empty className='min-h-64 rounded-xl border border-dashed border-violet-200/70 dark:border-violet-400/15'>
            <EmptyHeader>
              <EmptyTitle>{t('workflows.noMatchesTitle')}</EmptyTitle>
              <EmptyDescription>
                {t('workflows.noMatchesDescription')}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant='outline' size='sm' onClick={() => setQuery('')}>
                {t('workflows.clearSearch')}
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
      </main>
    </div>
  );
}

export { WorkflowsPage as Component };
