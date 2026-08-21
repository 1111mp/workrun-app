import { createContext, useContext, type ReactNode } from 'react';

import { type createWorkflowStore } from './workflow.store';

type WorkflowStoreApi = ReturnType<typeof createWorkflowStore>;

const WorkflowStoreContext = createContext<WorkflowStoreApi | null>(null);

type WorkflowStoreProviderProps = {
  children: ReactNode;
  store: WorkflowStoreApi;
};

function WorkflowStoreProvider({ children, store }: WorkflowStoreProviderProps) {
  return (
    <WorkflowStoreContext.Provider value={store}>
      {children}
    </WorkflowStoreContext.Provider>
  );
}

function useWorkflowStoreApi() {
  const store = useContext(WorkflowStoreContext);
  if (!store) {
    throw new Error('useWorkflowStoreApi must be used within WorkflowStoreProvider');
  }
  return store;
}

export { WorkflowStoreProvider, useWorkflowStoreApi };
