import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
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
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import {
  clearLegacyWorkflowDocument,
  createWorkflow,
  listWorkflows,
  loadLegacyWorkflowDocument,
  type StoredWorkflow,
} from '@/services/workflow';

function WorkflowCard({ workflow }: { workflow: StoredWorkflow }) {
  const { settings } = workflow.document;
  return (
    <Card size='sm' className='h-full'>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <div className='bg-muted flex size-8 items-center justify-center rounded-lg'>
            <WorkflowIcon className='text-muted-foreground size-4' />
          </div>
          <CardTitle className='truncate'>{settings.name}</CardTitle>
        </div>
        <CardDescription>
          {settings.description || 'No description provided.'}
        </CardDescription>
      </CardHeader>
      <CardContent className='text-muted-foreground flex flex-1 items-center gap-2 text-xs'>
        <span>{workflow.document.nodes.length} nodes</span>
        <span>{workflow.document.edges.length} connections</span>
        <span className='capitalize'>{settings.mode}</span>
      </CardContent>
      <CardFooter className='justify-end'>
        <Button
          size='sm'
          nativeButton={false}
          render={<Link to={`/workflows/${workflow.id}`} />}
        >
          <FilePenLineIcon data-icon='inline-start' />
          Edit workflow
        </Button>
      </CardFooter>
    </Card>
  );
}

function WorkflowListSkeleton() {
  return (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
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
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: listWorkflows,
  });
  const migrateLegacy = useMutation({
    mutationFn: createWorkflow,
    onSuccess: () => {
      clearLegacyWorkflowDocument();
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success('Existing workflow moved to Workflows', {
        toasterId: 'global',
      });
    },
  });

  useEffect(() => {
    if (
      workflows.data?.length ||
      migrateLegacy.isPending ||
      migrateLegacy.isError
    )
      return;
    const legacy = loadLegacyWorkflowDocument();
    if (legacy) migrateLegacy.mutate(legacy);
  }, [migrateLegacy, workflows.data]);

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
    <div className='size-full overflow-y-auto'>
      <main className='mx-auto flex w-full flex-col gap-3 px-6 py-3'>
        <section className='flex min-w-0 flex-wrap items-center gap-2.5'>
          <div className='mr-1 flex items-baseline gap-2'>
            <h1 className='text-lg font-semibold tracking-tight'>Workflows</h1>
            <span className='text-muted-foreground text-xs whitespace-nowrap'>
              {workflows.data?.length ?? '—'} local
            </span>
          </div>
          <InputGroup className='order-last w-full sm:order-0 sm:ml-auto sm:w-64'>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder='Search workflows'
              aria-label='Search workflows'
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
            Refresh
          </Button>
          <Button
            size='sm'
            nativeButton={false}
            render={<Link to='/workflows/new' />}
          >
            <PlusIcon data-icon='inline-start' />
            Create workflow
          </Button>
        </section>
        {workflows.isLoading || migrateLegacy.isPending ? (
          <WorkflowListSkeleton />
        ) : null}
        {filteredWorkflows?.length ? (
          <section className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'>
            {filteredWorkflows.map((workflow) => (
              <WorkflowCard key={workflow.id} workflow={workflow} />
            ))}
          </section>
        ) : null}
        {workflows.isError ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Workflows could not be loaded</EmptyTitle>
              <EmptyDescription>
                {workflows.error instanceof Error
                  ? workflows.error.message
                  : 'Try reopening the page.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {!workflows.isLoading &&
        !migrateLegacy.isPending &&
        !workflows.data?.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>Create your first workflow</EmptyTitle>
              <EmptyDescription>
                Combine Agents, Apps, and control flow into a reusable workflow.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                nativeButton={false}
                render={<Link to='/workflows/new' />}
              >
                <PlusIcon data-icon='inline-start' />
                Create workflow
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
        {workflows.data?.length && filteredWorkflows?.length === 0 ? (
          <Empty className='min-h-64 rounded-xl border border-dashed'>
            <EmptyHeader>
              <EmptyTitle>No matching workflows</EmptyTitle>
              <EmptyDescription>
                Try a different workflow name or description.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant='outline' size='sm' onClick={() => setQuery('')}>
                Clear search
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
      </main>
    </div>
  );
}

export { WorkflowsPage as Component };
