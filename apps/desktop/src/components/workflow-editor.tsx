import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
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
  Tabs,
  TabsList,
  TabsTrigger,
} from '@workspace/ui/components';
import {
  ArrowLeftIcon,
  HistoryIcon,
  SaveIcon,
  Settings2Icon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { WorkflowHistory } from '@/components/workflow-history';
import { WorkflowNodeInspector } from '@/components/workflow-node-inspector';
import { WorkflowRunPanel } from '@/components/workflow-run-panel';
import { WorkflowSettingsPanel } from '@/components/workflow-settings';
import { getModelCatalog } from '@/services/cmd';
import {
  inspectRunRecord,
  listRunHistoryPage,
  type RunHistoryCursor,
  type RunRecord,
} from '@/services/run-history';
import {
  createWorkflow,
  createWorkflowDocument,
  toWorkflowDocument,
  updateWorkflow,
  type StoredWorkflow,
  type WorkflowDocument,
  type WorkflowRunEvent,
  type WorkflowRunView,
} from '@/services/workflow';
import {
  createWorkflowStore,
  useWorkflowRunStore,
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
  autoStartRun?: boolean;
  historicalRun?: RunRecord;
};

function WorkflowEditor({
  workflow,
  autoStartRun,
  historicalRun,
}: WorkflowEditorProps) {
  const [draftDocument] = useState<WorkflowDocument>(() =>
    createWorkflowDocument(),
  );
  const [workflowStore] = useState(() =>
    createWorkflowStore(workflow?.document ?? draftDocument),
  );

  return (
    <WorkflowStoreProvider store={workflowStore}>
      <WorkflowEditorContent
        workflow={workflow}
        autoStartRun={autoStartRun}
        historicalRun={historicalRun}
      />
    </WorkflowStoreProvider>
  );
}

function WorkflowEditorContent({
  workflow,
  autoStartRun,
  historicalRun,
}: WorkflowEditorProps) {
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingHistoricalRunId, setViewingHistoricalRunId] = useState<
    string | undefined
  >();
  const [savedDocument, setSavedDocument] = useState<string>(() =>
    workflow ? JSON.stringify(workflow.document) : '',
  );
  const autoStartHandled = useRef(false);

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
  const workflowHistory = useInfiniteQuery({
    queryKey: ['run-history', 'workflow', workflow?.id],
    queryFn: ({ pageParam }) =>
      listRunHistoryPage({
        targetType: 'workflow',
        targetId: workflow?.id,
        pageSize: 20,
        cursor: pageParam,
      }),
    initialPageParam: undefined as RunHistoryCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: historyOpen && Boolean(workflow),
  });

  const runtime = historicalRun?.runtime as Record<string, unknown> | undefined;
  const restoredRun =
    typeof runtime?.threadId === 'string'
      ? { id: historicalRun!.id, threadId: runtime.threadId }
      : undefined;

  const workflowRun = useWorkflowRun(
    workflow?.id ?? draftId,
    nodes,
    edges,
    workflowSettings,
    restoredRun,
  );

  const restoreHistoricalRun = useWorkflowRunStore(
    useShallow((state) => ({
      setRunPanelOpen: state.setRunPanelOpen,
      setRunView: state.setRunView,
      setShowRunOutput: state.setShowRunOutput,
      resetRunView: state.resetRunView,
      applyRunEvents: state.applyRunEvents,
    })),
  );
  useEffect(() => {
    if (!historicalRun) {
      // The run store is shared across editors. A normal workflow must never
      // inherit the read-only output that was restored for a historical run.
      restoreHistoricalRun.resetRunView();
      restoreHistoricalRun.setShowRunOutput(false);
      restoreHistoricalRun.setRunPanelOpen(false);
      return;
    }
  }, [historicalRun, restoreHistoricalRun]);

  useEffect(() => {
    if (!historicalRun) return;
    restoreHistoricalRun.setRunView(
      historicalRun.outputView as WorkflowRunView,
    );
    // Native sessions persist the transport trace, so an active run can be
    // reconstructed after its original editor was closed or unmounted.
    restoreHistoricalRun.applyRunEvents(
      historicalRun.events.map(({ event }) => event as WorkflowRunEvent),
      { mode: workflowSettings.mode, nodes },
    );
    restoreHistoricalRun.setShowRunOutput(true);
    restoreHistoricalRun.setRunPanelOpen(true);
  }, [historicalRun, nodes, workflowSettings.mode, restoreHistoricalRun]);

  const openHistoricalRun = async (id: string) => {
    try {
      const record = await inspectRunRecord(id);
      restoreHistoricalRun.setRunView(record.outputView as WorkflowRunView);
      restoreHistoricalRun.applyRunEvents(
        record.events.map(({ event }) => event as WorkflowRunEvent),
        { mode: workflowSettings.mode, nodes },
      );
      restoreHistoricalRun.setShowRunOutput(true);
      restoreHistoricalRun.setRunPanelOpen(true);
      setViewingHistoricalRunId(id);
    } catch (error) {
      toast.error('Could not load run output', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  useEffect(() => {
    if (!autoStartRun || autoStartHandled.current) return;
    autoStartHandled.current = true;
    workflowRun.startRun();
  }, [autoStartRun, workflowRun]);

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
        void navigate(`/workflows/${saved.id}`, { replace: true });
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
        canvasContent={
          historyOpen && workflow ? (
            <WorkflowHistory
              runs={
                workflowHistory.data?.pages.flatMap((page) => page.items) ?? []
              }
              isLoading={workflowHistory.isLoading}
              hasMore={workflowHistory.hasNextPage}
              isLoadingMore={workflowHistory.isFetchingNextPage}
              onLoadMore={() => void workflowHistory.fetchNextPage()}
              onView={(id) => void openHistoricalRun(id)}
            />
          ) : undefined
        }
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
              <Tabs
                value={historyOpen ? 'history' : 'canvas'}
                onValueChange={(value) => setHistoryOpen(value === 'history')}
              >
                <TabsList aria-label='Workflow view'>
                  <TabsTrigger value='canvas'>Canvas</TabsTrigger>
                  <TabsTrigger value='history' disabled={!workflow}>
                    <HistoryIcon data-icon='inline-start' />
                    History
                  </TabsTrigger>
                </TabsList>
              </Tabs>
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
          workflowId={workflow?.id}
          executableNodes={nodes.filter((node) => isExecutableNode(node.type))}
          modelProfiles={modelCatalog}
          onClose={clearSelection}
          onDataChange={updateNodeData}
        />
        <WorkflowSettingsPanel
          open={settingsOpen}
          settings={workflowSettings}
          executableNodes={nodes
            .filter((node) => isExecutableNode(node.type))
            .map((node) => ({
              id: node.id,
              name:
                (typeof node.data.name === 'string' && node.data.name) ||
                (typeof node.data.label === 'string' && node.data.label) ||
                node.type ||
                node.id,
            }))}
          onOpenChange={setSettingsOpen}
          onSettingsChange={updateWorkflowSettings}
        />
        <WorkflowRunPanel
          settings={workflowSettings}
          nodes={nodes}
          onRun={workflowRun.startWorkflowRun}
          onResume={workflowRun.resumeWorkflowRun}
          readOnly={Boolean(historicalRun || viewingHistoricalRunId)}
          onHistoricalClose={() => {
            if (historicalRun) void navigate(-1);
            else {
              setViewingHistoricalRunId(undefined);
              restoreHistoricalRun.setRunPanelOpen(false);
            }
          }}
        />
      </WorkflowCanvas>
    </SidebarProvider>
  );
}

function isExecutableNode(type: string | undefined) {
  return (
    type === 'agent' ||
    type === 'codeact_agent' ||
    type === 'remote_agent' ||
    type === 'process' ||
    type === 'if_else' ||
    type === 'switch' ||
    type === 'human_review' ||
    type === 'ask_user_question' ||
    type === 'subworkflow'
  );
}

export { WorkflowEditor };
