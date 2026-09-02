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
import { inspectWorkflow } from '@/services/workflow';

function WorkflowPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();

  const workflow = useQuery({
    queryKey: ['workflows', id],
    queryFn: () => inspectWorkflow(id!),
    enabled: Boolean(id),
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
        autoStartRun={searchParams.get('run') === 'true'}
      />
    </ReactFlowProvider>
  );
}

export { WorkflowPage as Component };
