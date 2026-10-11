import { useQuery } from '@tanstack/react-query';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Spinner,
} from '@workspace/ui/components';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';

import { WorkflowEditor } from '@/components';
import { runCenterEntries } from '@/services/run-center';
import { inspectRunRecord, listActiveRuns } from '@/services/run-history';
import { getPublishedWorkflow, getWorkflow } from '@/services/workflow';
import { useWorkflowRunStore, useWorkrunStore } from '@/stores';

function WorkflowPage() {
  const { id } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const historyRunId = searchParams.get('runId');
  const historyChatSessionId = searchParams.get('chatSessionId');
  const isPublishedView = searchParams.get('catalog') === 'true';
  const workspace = useWorkrunStore(
    (state) => state.config?.workspace_mode ?? 'personal',
  );

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
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  const workflow = useQuery({
    queryKey: ['workflows', id, isPublishedView ? 'published' : 'draft'],
    queryFn: () =>
      isPublishedView ? getPublishedWorkflow(id!) : getWorkflow(id!),
    enabled: Boolean(id),
  });
  const historicalRun = useQuery({
    queryKey: ['run-history', historyRunId],
    queryFn: () => inspectRunRecord(historyRunId!),
    enabled: Boolean(historyRunId),
    refetchOnMount: 'always',
  });

  const outputRunId =
    historicalRun.data?.targetType === 'workflow' &&
    historicalRun.data.targetId === id
      ? historicalRun.data.id
      : undefined;
  useEffect(() => {
    if (!outputRunId) return;
    // Selecting the same task again must reopen its existing panel even when
    // the route and cached record are unchanged. Preserve the editor itself.
    const output = useWorkflowRunStore.getState();
    output.setShowRunOutput(true);
    output.setRunPanelOpen(true);
  }, [outputRunId, location.key]);

  if (workflow.isLoading || activeRun.isLoading) {
    return (
      <div className='text-muted-foreground flex size-full items-center justify-center gap-2 text-sm'>
        <Spinner />
        Loading workflow…
      </div>
    );
  }

  if (!workflow.data) {
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
        key={workflow.data.id}
        workflow={workflow.data}
        readOnly={isPublishedView}
        allowRun={isPublishedView}
        autoStartRun={searchParams.get('run') === 'true'}
        liveRun={
          searchParams.get('live') === 'true' ||
          (!historyRunId && Boolean(activeRun.data))
        }
        historicalRun={
          historicalRun.data?.targetType === 'workflow' &&
          historicalRun.data.targetId === workflow.data.id
            ? historicalRun.data
            : !historyRunId && !historyChatSessionId
              ? (activeRun.data ?? undefined)
              : undefined
        }
        historicalChatSessionId={historyChatSessionId ?? undefined}
      />
    </ReactFlowProvider>
  );
}

export { WorkflowPage as Component };
