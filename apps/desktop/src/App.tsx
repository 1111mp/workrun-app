import { ReactFlowProvider } from '@xyflow/react';

import { WorkflowEditor } from '@/components';

function App() {
  return (
    <ReactFlowProvider>
      <WorkflowEditor />
    </ReactFlowProvider>
  );
}

export default App;
