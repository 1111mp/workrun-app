import { lazy, Suspense } from 'react';

import {
  loadNewWorkflowPage,
  loadWorkflowPage,
} from '@/lib/workflow-page-loader';

import { WorkflowPageSkeleton } from './workflow-page-skeleton';

const WorkflowPage = lazy(loadWorkflowPage);
const NewWorkflowPage = lazy(loadNewWorkflowPage);

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
