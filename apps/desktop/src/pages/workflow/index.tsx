import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Spinner,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@workspace/ui/components';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useLocation,
  useParams,
  useSearchParams,
  useViewTransitionState,
} from 'react-router';

import { WorkflowEditor } from '@/components';
import { runCenterEntries } from '@/services/run-center';
import { inspectRunRecord, listActiveRuns } from '@/services/run-history';
import { getPublishedWorkflow, getWorkflow } from '@/services/workflow';
import { useWorkflowRunStore, useWorkrunStore } from '@/stores';

import { WorkflowPageSkeleton } from './workflow-page-skeleton';

function WorkflowPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const openedHistoryEntry = useRef<string | undefined>(undefined);
  const location = useLocation();
  const transitioning = useViewTransitionState(location.pathname);
  const mountedWorkflowId = useRef<string | undefined>(undefined);
  const [searchParams] = useSearchParams();
  const historyRunId = searchParams.get('runId');
  const historyChatSessionId = searchParams.get('chatSessionId');
  const workspace = useWorkrunStore(
    (state) => state.config?.workspace_mode ?? 'personal',
  );

  // A run launched outside the authoring canvas must not execute a Team draft.
  const isPublishedView =
    searchParams.get('catalog') === 'true' ||
    (workspace === 'team' &&
      (searchParams.get('run') === 'true' ||
        searchParams.get('live') === 'true'));

  const activeRun = useQuery({
    queryKey: ['workflow-entry-active-run', workspace, id, location.key],
    queryFn: async () => {
      const runs = (await listActiveRuns()).filter(
        (run) =>
          run.targetType === 'workflow' &&
          run.targetId === id &&
          ['queued', 'running', 'waiting_for_input'].includes(run.status),
      );
      const selected = runCenterEntries(runs, [])[0]?.run;
      return selected ? inspectRunRecord(selected.id) : null;
    },
    enabled:
      Boolean(id) &&
      !historyRunId &&
      !historyChatSessionId &&
      searchParams.get('run') !== 'true',
    // Discover once on entry. Later runtime updates must not replace the run
    // being viewed or reopen a panel the user has deliberately closed.
    retry: false,
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  const workflow = useQuery({
    queryKey: ['workflows', id, isPublishedView ? 'published' : 'draft'],
    queryFn: () =>
      isPublishedView ? getPublishedWorkflow(id!) : getWorkflow(id!),
    enabled: Boolean(id),
    retry: false,
  });
  const historicalRun = useQuery({
    queryKey: ['run-history', historyRunId],
    queryFn: () => inspectRunRecord(historyRunId!),
    enabled: Boolean(historyRunId),
    retry: false,
    refetchOnMount: 'always',
  });

  const displayedWorkflow = workflow.data;
  // Run event reconstruction can span many native reads; it must not gate canvas mount.
  const entryLoading = workflow.isLoading;
  const runLoading = activeRun.isLoading || historicalRun.isLoading;
  const runLoadFailed =
    (activeRun.isError && activeRun.data === undefined) ||
    (historicalRun.isError && historicalRun.data === undefined);
  const runEntryBlocked = runLoading || runLoadFailed;
  // A portal drawer must not begin sliding inside the route's frozen snapshot.
  // Preserve an existing editor during outgoing and same-workflow transitions.
  const deferEditor =
    transitioning && mountedWorkflowId.current !== displayedWorkflow?.id;
  const editorReady =
    !entryLoading && !deferEditor && Boolean(displayedWorkflow);

  const outputRunId =
    historicalRun.data?.targetType === 'workflow' &&
    historicalRun.data.targetId === id
      ? historicalRun.data.id
      : undefined;
  useEffect(() => {
    if (!editorReady) return;
    mountedWorkflowId.current = displayedWorkflow?.id;
    if (!outputRunId || transitioning) return;
    const entry = `${location.key}:${outputRunId}`;
    if (openedHistoryEntry.current === entry) return;
    openedHistoryEntry.current = entry;
    // Reopening a record is intentional navigation; cache refreshes should
    // preserve the panel's state. Wait until the route snapshot is released.
    const output = useWorkflowRunStore.getState();
    output.setShowRunOutput(true);
    output.setRunPanelOpen(true);
  }, [
    outputRunId,
    location.key,
    editorReady,
    transitioning,
    displayedWorkflow?.id,
  ]);

  if (entryLoading || deferEditor) {
    return <WorkflowPageSkeleton />;
  }

  if (!displayedWorkflow) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Workflow not found</EmptyTitle>
          <EmptyDescription>
            {workflow.error instanceof Error
              ? workflow.error.message
              : 'Return to Workflows and choose another workflow.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ReactFlowProvider>
      <WorkflowEditor
        key={displayedWorkflow.id}
        workflow={displayedWorkflow}
        readOnly={isPublishedView}
        allowRun={isPublishedView}
        autoStartRun={searchParams.get('run') === 'true'}
        liveRun={
          searchParams.get('live') === 'true' ||
          (!historyRunId && Boolean(activeRun.data))
        }
        historicalRun={
          historicalRun.data?.targetType === 'workflow' &&
          (historicalRun.data.targetId === displayedWorkflow.id ||
            historicalRun.data.targetId === id)
            ? historicalRun.data
            : !historyRunId && !historyChatSessionId
              ? (activeRun.data ?? undefined)
              : undefined
        }
        historicalChatSessionId={historyChatSessionId ?? undefined}
        runEntryBlocked={runEntryBlocked}
        entryNotice={
          runEntryBlocked ? (
            <div
              role='status'
              className='text-muted-foreground flex items-center gap-2 px-4 py-2 text-sm'
            >
              {runLoading ? <Spinner className='size-4' /> : null}
              <span>
                {t(
                  runLoadFailed
                    ? 'workflowEditor.entryRunFailed'
                    : 'workflowEditor.entryRunLoading',
                )}
              </span>
              {runLoadFailed ? (
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => {
                    if (activeRun.isError) void activeRun.refetch();
                    if (historicalRun.isError) void historicalRun.refetch();
                  }}
                >
                  {t('workflowEditor.entryRunRetry')}
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      />
    </ReactFlowProvider>
  );
}

export { WorkflowPage as Component };
