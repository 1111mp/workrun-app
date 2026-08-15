import { ReactFlowProvider } from '@xyflow/react';

import { WorkflowEditor } from '@/components';

function NewWorkflowPage() {
  return (
    <ReactFlowProvider>
      <WorkflowEditor />
    </ReactFlowProvider>
  );
}

export { NewWorkflowPage as Component };
