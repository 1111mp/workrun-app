import { lazy, Suspense } from 'react';

import { WorkflowPageSkeleton } from './workflow-page-skeleton';

const WorkflowPage = lazy(() =>
  import('@/pages/workflow').then(({ Component }) => ({ default: Component })),
);
const NewWorkflowPage = lazy(() =>
  import('@/pages/workflows/new').then(({ Component }) => ({
    default: Component,
  })),
);

// route.lazy waits for the whole editor module before committing navigation.
// Keep these shells eager so every entry can navigate and show loading feedback
// while the first editor download and module evaluation are still pending.
export function WorkflowRoute() {
  return (
    <Suspense fallback={<WorkflowPageSkeleton />}>
      <WorkflowPage />
    </Suspense>
  );
}

export function NewWorkflowRoute() {
  return (
    <Suspense fallback={<WorkflowPageSkeleton />}>
      <NewWorkflowPage />
    </Suspense>
  );
}
