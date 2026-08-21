import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Badge,
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  SidebarProvider,
  SidebarTrigger,
} from '@workspace/ui/components';
import {
  ArrowLeftIcon,
  SaveIcon,
  Settings2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useStore } from 'zustand';

import { WorkflowNodeInspector } from '@/components/workflow-node-inspector';
import { WorkflowRunPanel } from '@/components/workflow-run-panel';
import { WorkflowSettingsPanel } from '@/components/workflow-settings';
import { getModelCatalog } from '@/services/cmd';
import {
  createWorkflow,
  createWorkflowDocument,
  toWorkflowDocument,
  updateWorkflow,
  type StoredWorkflow,
  type WorkflowDocument,
} from '@/services/workflow';
import {
  createWorkflowStore,
  useWorkflowStoreApi,
  WorkflowStoreProvider,
} from '@/stores';

import { useWorkflowRun } from './workflow-editor/use-workflow-run';
import { WorkflowCanvas } from './workflow-editor/workflow-canvas';

const WORKFLOW_MODE = [
  { value: 'task', label: 'Task' },
  { value: 'chat', label: 'Chat' },
];

type WorkflowEditorProps = {
  workflow?: StoredWorkflow;
};

function WorkflowEditor({ workflow }: WorkflowEditorProps) {
  const [draftDocument] = useState<WorkflowDocument>(() =>
    createWorkflowDocument(),
  );
  const [workflowStore] = useState(() =>
    createWorkflowStore(workflow?.document ?? draftDocument),
  );

  return (
    <WorkflowStoreProvider store={workflowStore}>
      <WorkflowEditorContent workflow={workflow} />
    </WorkflowStoreProvider>
  );
}

function WorkflowEditorContent({ workflow }: WorkflowEditorProps) {
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [savedDocument, setSavedDocument] = useState<string>(() =>
    workflow ? JSON.stringify(workflow.document) : '',
  );

  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draftId] = useState(() => crypto.randomUUID());
  const workflowStore = useWorkflowStoreApi();
  const nodes = useStore(workflowStore, (state) => state.nodes);
  const edges = useStore(workflowStore, (state) => state.edges);
  const selectedNodeId = useStore(
    workflowStore,
    (state) => state.selectedNodeId,
  );
  const workflowSettings = useStore(workflowStore, (state) => state.settings);
  const updateNodeData = useStore(
    workflowStore,
    (state) => state.updateNodeData,
  );
  const updateWorkflowSettings = useStore(
    workflowStore,
    (state) => state.updateSettings,
  );
  const clearSelection = useStore(
    workflowStore,
    (state) => state.clearSelection,
  );

  const workflowDocument = toWorkflowDocument(nodes, edges, workflowSettings);
  const workflowDocumentSnapshot = JSON.stringify(workflowDocument);
  const isDirty = workflowDocumentSnapshot !== savedDocument;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  const { data: modelCatalog } = useQuery({
    queryKey: ['modelCatalog'],
    queryFn: getModelCatalog,
  });
  const workflowRun = useWorkflowRun(
    workflow?.id ?? draftId,
    nodes,
    edges,
    workflowSettings,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
      ) {
        return;
      }
      if (!event.metaKey && !event.ctrlKey) return;

      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        const { undo, pastStates } = workflowStore.temporal.getState();
        if (pastStates.length > 0) undo();
      }
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        const { redo, futureStates } = workflowStore.temporal.getState();
        if (futureStates.length > 0) redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workflowStore]);

  const saveWorkflow = async () => {
    try {
      const saved = workflow
        ? await updateWorkflow(workflow.id, workflowDocument)
        : await createWorkflow(workflowDocument);
      setSavedDocument(workflowDocumentSnapshot);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(workflow ? 'Workflow saved' : 'Workflow created', {
        toasterId: 'global',
      });
      if (!workflow) {
        navigate(`/workflows/${saved.id}`, { replace: true });
      }
    } catch (error) {
      toast.error('Workflow could not be saved', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <SidebarProvider className='relative flex size-full min-h-0! grow flex-row'>
      <WorkflowCanvas
        isRunning={workflowRun.isRunning}
        runningNodeId={workflowRun.runningNodeId}
        onRun={workflowRun.startRun}
        header={
          <header className='flex h-10 shrink-0 items-center gap-2 pt-1 pr-4'>
            <div className='flex flex-1 items-center gap-2 px-4'>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label='Back to workflows'
                nativeButton={false}
                render={<Link to='/workflows' />}
              >
                <ArrowLeftIcon />
              </Button>
              <SidebarTrigger className='-ml-1' />
              <Separator
                orientation='vertical'
                className='my-auto mr-2 data-[orientation=vertical]:h-4'
              />
              <FieldGroup className='flex-row items-center gap-2'>
                <Field className='w-52'>
                  <FieldLabel className='sr-only' htmlFor='workflow-name'>
                    Workflow name
                  </FieldLabel>
                  <Input
                    id='workflow-name'
                    className='border-none'
                    value={workflowSettings.name}
                    onChange={(event) =>
                      updateWorkflowSettings({ name: event.target.value })
                    }
                  />
                </Field>
                <Field className='w-28'>
                  <FieldLabel className='sr-only' htmlFor='workflow-mode'>
                    Run mode
                  </FieldLabel>
                  <Select
                    items={WORKFLOW_MODE}
                    value={workflowSettings.mode}
                    onValueChange={(mode) =>
                      updateWorkflowSettings({ mode: mode as WorkflowMode })
                    }
                  >
                    <SelectTrigger
                      id='workflow-mode'
                      className='w-full border-none'
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {WORKFLOW_MODE.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
            </div>
            <div className='flex items-center gap-2'>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2Icon data-icon='inline-start' />
                More settings
              </Button>
              <Button
                size='sm'
                disabled={Boolean(workflow) && !isDirty}
                onClick={() => void saveWorkflow()}
              >
                <SaveIcon data-icon='inline-start' />
                {workflow ? 'Save' : 'Create workflow'}
              </Button>
            </div>
          </header>
        }
      >
        <WorkflowNodeInspector
          node={selectedNode}
          modelProfiles={modelCatalog}
          onClose={clearSelection}
          onDataChange={updateNodeData}
        />
        <WorkflowSettingsPanel
          open={settingsOpen}
          settings={workflowSettings}
          onOpenChange={setSettingsOpen}
          onSettingsChange={updateWorkflowSettings}
        />
        <WorkflowRunPanel
          settings={workflowSettings}
          onRun={workflowRun.startWorkflowRun}
          onResume={workflowRun.resumeWorkflowRun}
        />
        <AlertDialog open={Boolean(workflowRun.toolApproval)}>
          <AlertDialogContent>
            <AlertDialogHeader className='grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-2 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
              <AlertDialogMedia className='mb-0 size-8'>
                <ShieldAlertIcon />
              </AlertDialogMedia>
              <div className='min-w-0 space-y-1.5'>
                <AlertDialogTitle>
                  Allow {String(workflowRun.toolApproval?.name ?? 'Tool')} to
                  run?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {typeof workflowRun.toolApproval?.description === 'string'
                    ? workflowRun.toolApproval.description
                    : 'The Agent requested a Tool App execution.'}
                </AlertDialogDescription>
                <div className='flex flex-wrap gap-1.5 pt-1'>
                  <Badge variant='outline'>
                    Source:{' '}
                    {String(
                      workflowRun.toolApproval?.sourceName ??
                        workflowRun.toolApproval?.source ??
                        'Tool App',
                    )}
                  </Badge>
                  <Badge variant='secondary'>
                    Risk:{' '}
                    {String(workflowRun.toolApproval?.riskLevel ?? 'unknown')}
                  </Badge>
                </div>
              </div>
            </AlertDialogHeader>
            <pre className='bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs'>
              {JSON.stringify(workflowRun.toolApproval?.input ?? {}, null, 2)}
            </pre>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() =>
                  void workflowRun.resolvePendingToolApproval(false)
                }
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void workflowRun.resolvePendingToolApproval(true)
                }
              >
                Run tool
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={Boolean(workflowRun.humanReview)}>
          <AlertDialogContent>
            <AlertDialogHeader className='grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-2 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
              <AlertDialogMedia className='mb-0 size-8'>
                <ShieldCheckIcon />
              </AlertDialogMedia>
              <div className='min-w-0 space-y-1.5'>
                <AlertDialogTitle>
                  {String(
                    workflowRun.humanReview?.title ?? 'Human review required',
                  )}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {typeof workflowRun.humanReview?.description === 'string'
                    ? workflowRun.humanReview.description
                    : 'Review the workflow context before allowing it to continue.'}
                </AlertDialogDescription>
                <p className='text-muted-foreground text-sm'>
                  Approval and rejection follow their matching workflow outputs.
                  An unconnected output stops this run.
                </p>
              </div>
            </AlertDialogHeader>
            <pre className='bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs'>
              {JSON.stringify(workflowRun.humanReview?.context ?? {}, null, 2)}
            </pre>
            <AlertDialogFooter>
              <AlertDialogCancel
                disabled={workflowRun.isResolvingHumanReview}
                onClick={() =>
                  void workflowRun.resolvePendingHumanReview(false)
                }
              >
                Reject
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={workflowRun.isResolvingHumanReview}
                onClick={() => void workflowRun.resolvePendingHumanReview(true)}
              >
                {workflowRun.isResolvingHumanReview
                  ? 'Saving decision…'
                  : 'Approve & continue'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </WorkflowCanvas>
    </SidebarProvider>
  );
}

export { WorkflowEditor };
