import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Skeleton,
  Spinner,
} from '@workspace/ui/components';
import {
  AppWindowIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  SearchIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useEntryWorkspace } from '@/components/app-sidebar';
import { matchesCapability } from '@/lib/capability-search';
import { isTeamMode } from '@/lib/constant';
import {
  ensurePublishedProcessNode,
  getProcessNodes,
  startBackgroundProcessNodeRun,
  type ProcessNode,
} from '@/services/process-node';
import { getWorkflowCapabilities } from '@/services/workflow';

function StartPage() {
  const workspace = useEntryWorkspace();
  const location = useLocation();
  return (
    <StartContent key={`${workspace}:${location.key}`} workspace={workspace} />
  );
}

function StartContent({ workspace }: { workspace: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState<string>();
  const startingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const workflows = useQuery({
    queryKey: ['entry-workflows', workspace],
    queryFn: getWorkflowCapabilities,
  });
  const apps = useQuery({
    queryKey: ['entry-apps', workspace],
    queryFn: getProcessNodes,
  });

  const workflowItems = (workflows.data ?? []).filter((item) =>
    matchesCapability(
      query,
      item.document.settings.name,
      item.document.settings.description,
    ),
  );
  const appItems = (apps.data ?? []).filter(
    (item) =>
      item.definition.kind !== 'tool' &&
      matchesCapability(
        query,
        item.definition.name,
        item.definition.description,
      ),
  );
  const pending = workflows.isPending || apps.isPending;
  const hasError = workflows.isError || apps.isError;
  const count = workflowItems.length + appItems.length;

  const search = () => {
    setQuery(draft.trim());
  };
  const runApp = async (app: ProcessNode) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(app.definition.id);
    try {
      const node =
        isTeamMode() && app.installStatus !== 'draft'
          ? await ensurePublishedProcessNode(app, () => undefined)
          : app;
      const runId = crypto.randomUUID();
      // Native run history owns output and interaction recovery after leaving this page.
      await startBackgroundProcessNodeRun({
        runId,
        targetId: node.definition.id,
        targetName: node.definition.name,
        targetSnapshot: node.definition,
        outputView: {
          isRunning: true,
          node,
          output: { stdout: '', stderr: '' },
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['run-history'] });
      await navigate(`/apps?${new URLSearchParams({ runId })}`);
    } catch (error) {
      toast.error(t('apps.startFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    } finally {
      startingRef.current = false;
      setStarting(undefined);
    }
  };

  return (
    <div className='h-full overflow-y-auto'>
      <div className='mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-7 px-6 py-12'>
        <div className='flex flex-col items-center gap-3 text-center'>
          <span className='text-muted-foreground text-xs font-medium tracking-widest'>
            WORKRUN
          </span>
          <h1 className='text-3xl font-medium tracking-tight sm:text-4xl'>
            {t('start.title')}
          </h1>
          <p className='text-muted-foreground text-sm'>{t('start.subtitle')}</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <InputGroup>
            <InputGroupTextarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('start.placeholder')}
              aria-label={t('start.searchLabel')}
              className='min-h-28'
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  search();
                }
              }}
            />
            <InputGroupAddon align='block-end'>
              <SearchIcon />
              <span className='text-muted-foreground flex-1 text-xs'>
                {t('start.searchHint')}
              </span>
              <InputGroupButton
                type='submit'
                variant='default'
                size='icon-sm'
                aria-label={t('start.searchLabel')}
              >
                <ArrowUpIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
        {hasError && (
          <Alert variant='destructive'>
            <AlertTitle>{t('start.loadError')}</AlertTitle>
            <AlertDescription>
              <p>{t('start.loadErrorDescription')}</p>
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  void workflows.refetch();
                  void apps.refetch();
                }}
              >
                {t('start.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        <section
          className='flex flex-col gap-3'
          aria-label={t('start.capabilities')}
          aria-live='polite'
        >
          <div className='flex items-center justify-between gap-3'>
            <h2 className='text-muted-foreground text-xs font-medium'>
              {t(query ? 'start.searchResults' : 'start.capabilities')}
            </h2>
            {query && (
              <Button
                size='sm'
                variant='ghost'
                onClick={() => {
                  setQuery('');
                  setDraft('');
                  inputRef.current?.focus();
                }}
              >
                {t('start.clearSearch')}
              </Button>
            )}
          </div>
          {!query && (workflowItems.length > 3 || appItems.length > 3) && (
            <p className='text-muted-foreground text-xs'>
              {t('start.moreCapabilities')}
            </p>
          )}
          {pending && (
            <div className='flex flex-col gap-2'>
              <Skeleton className='h-16 w-full' />
              <Skeleton className='h-16 w-full' />
            </div>
          )}
          {(query ? workflowItems : workflowItems.slice(0, 3)).map(
            (workflow) => (
              <div
                key={workflow.id}
                className='flex items-center gap-3 rounded-xl border p-4'
              >
                <WorkflowIcon className='text-muted-foreground size-5 shrink-0' />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2'>
                    <span className='truncate text-sm font-medium'>
                      {workflow.document.settings.name}
                    </span>
                    <Badge variant='secondary'>
                      {t('navigation.workflow')}
                    </Badge>
                  </div>
                  <p className='text-muted-foreground mt-1 line-clamp-2 text-xs'>
                    {workflow.document.settings.description ||
                      t('workflows.noDescription')}
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='ghost'
                  nativeButton={false}
                  render={
                    <Link
                      to={`/workflows/${encodeURIComponent(workflow.id)}?${new URLSearchParams({ run: 'true', ...(workflow.editable === false ? { catalog: 'true' } : {}) })}`}
                    />
                  }
                >
                  {t('start.configureRun')}
                  <ArrowUpRightIcon data-icon='inline-end' />
                </Button>
              </div>
            ),
          )}
          {(query ? appItems : appItems.slice(0, 3)).map((app) => (
            <div
              key={app.definition.id}
              className='flex items-center gap-3 rounded-xl border p-4'
            >
              <AppWindowIcon className='text-muted-foreground size-5 shrink-0' />
              <div className='min-w-0 flex-1'>
                <div className='flex items-center gap-2'>
                  <span className='truncate text-sm font-medium'>
                    {app.definition.name}
                  </span>
                  <Badge variant='secondary'>{t('navigation.apps')}</Badge>
                </div>
                <p className='text-muted-foreground mt-1 line-clamp-2 text-xs'>
                  {app.definition.description}
                </p>
              </div>
              <Button
                size='sm'
                variant='ghost'
                disabled={Boolean(starting) || app.installStatus === 'invalid'}
                onClick={() => void runApp(app)}
              >
                {starting === app.definition.id && (
                  <Spinner data-icon='inline-start' />
                )}
                {t('start.run')}
              </Button>
            </div>
          ))}
          {!pending && !hasError && count === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {t(query ? 'start.noMatches' : 'start.emptyTitle')}
                </EmptyTitle>
                <EmptyDescription>
                  {t(
                    query
                      ? 'start.noMatchesDescription'
                      : 'start.emptyDescription',
                  )}
                </EmptyDescription>
              </EmptyHeader>
              <div className='flex flex-wrap justify-center gap-2'>
                <Button
                  size='sm'
                  nativeButton={false}
                  render={<Link to='/workflows' />}
                >
                  {t('navigation.workflow')}
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  nativeButton={false}
                  render={<Link to='/apps' />}
                >
                  {t('navigation.apps')}
                </Button>
              </div>
            </Empty>
          )}
        </section>
      </div>
    </div>
  );
}

export { StartPage as Component };
