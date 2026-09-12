import { useQuery } from '@tanstack/react-query';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Spinner,
} from '@workspace/ui/components';
import { ReactFlowProvider } from '@xyflow/react';
import { useParams, useSearchParams } from 'react-router';

import { WorkflowEditor } from '@/components';
import { inspectRunRecord } from '@/services/run-history';
import { getPublishedWorkflow, getWorkflow } from '@/services/workflow';

function WorkflowPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const historyRunId = searchParams.get('runId');
  const isPublishedView = searchParams.get('catalog') === 'true';

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
  });

  if (workflow.isLoading) {
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
        historicalRun={
          historicalRun.data?.targetType === 'workflow' &&
          historicalRun.data.targetId === workflow.data.id
            ? historicalRun.data
            : undefined
        }
      />
    </ReactFlowProvider>
  );
}

export { WorkflowPage as Component };
