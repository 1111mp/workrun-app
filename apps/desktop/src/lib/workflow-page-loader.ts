let detail: ReturnType<typeof importDetail> | undefined;
let create: ReturnType<typeof importCreate> | undefined;

const importDetail = () =>
  import('@/pages/workflow').then(({ Component }) => ({ default: Component }));
const importCreate = () =>
  import('@/pages/workflows/new').then(({ Component }) => ({
    default: Component,
  }));

// Share speculative imports with React.lazy, but allow navigation to retry a
// failed preload instead of permanently retaining a rejected promise.
export function loadWorkflowPage() {
  return (detail ??= importDetail().catch((error) => {
    detail = undefined;
    throw error;
  }));
}

export function loadNewWorkflowPage() {
  return (create ??= importCreate().catch((error) => {
    create = undefined;
    throw error;
  }));
}

export function preloadWorkflowPage(newWorkflow = false) {
  void (newWorkflow ? loadNewWorkflowPage() : loadWorkflowPage()).catch(
    () => {},
  );
}
