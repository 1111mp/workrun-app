import { ReactFlowProvider } from '@xyflow/react';

import { WorkflowEditor } from '@/components';

function WorkflowPage() {
  return (
    <ReactFlowProvider>
      <WorkflowEditor />
    </ReactFlowProvider>
  );
}

export { WorkflowPage as Component };
