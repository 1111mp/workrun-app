import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
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
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@workspace/ui/components';
import {
  ArrowLeftIcon,
  HistoryIcon,
  SaveIcon,
  Settings2Icon,
  UploadIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { WorkflowHistory } from '@/components/workflow-history';
import { WorkflowNodeInspector } from '@/components/workflow-node-inspector';
import { WorkflowRunPanel } from '@/components/workflow-run-panel';
import { WorkflowSettingsPanel } from '@/components/workflow-settings';
import { isTeamMode } from '@/lib/constant';
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
  publishWorkflow,
  toWorkflowDocument,
  updateWorkflow,
  type StoredWorkflow,
  type WorkflowDocument,
  type WorkflowRunEvent,
} from '@/services/workflow';
import {
  createWorkflowStore,
  restoreWorkflowRunView,
  useWorkflowRunStore,
  useWorkflowStoreApi,
  WorkflowStoreProvider,
} from '@/stores';

import { useWorkflowRun } from './workflow-editor/use-workflow-run';
import { WorkflowCanvas } from './workflow-editor/workflow-canvas';

type WorkflowEditorProps = {
  workflow?: StoredWorkflow;
  readOnly?: boolean;
  allowRun?: boolean;
  autoStartRun?: boolean;
  historicalRun?: RunRecord;
};

function WorkflowEditor({
  workflow,
  readOnly,
  allowRun,
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
        readOnly={readOnly}
        allowRun={allowRun}
        autoStartRun={autoStartRun}
        historicalRun={historicalRun}
      />
    </WorkflowStoreProvider>
  );
}

function WorkflowEditorContent({
  workflow,
  readOnly = false,
  allowRun = false,
  autoStartRun,
  historicalRun,
}: WorkflowEditorProps) {
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [version, setVersion] = useState('1.0.0');
  const [releaseNote, setReleaseNote] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewingHistoricalRunId, setViewingHistoricalRunId] = useState<
    string | undefined
  >();
  const [createdWorkflow, setCreatedWorkflow] = useState<
    StoredWorkflow | undefined
  >();
  const activeWorkflow = workflow ?? createdWorkflow;
  const [savedDocument, setSavedDocument] = useState<string>(() =>
    workflow ? JSON.stringify(workflow.document) : '',
  );
  const autoStartHandled = useRef(false);
  const creatingWorkflow = useRef<Promise<StoredWorkflow> | undefined>(null);

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
    queryKey: ['run-history', 'workflow', activeWorkflow?.id],
    queryFn: ({ pageParam }) =>
      listRunHistoryPage({
        targetType: 'workflow',
        targetId: activeWorkflow?.id,
        pageSize: 20,
        cursor: pageParam,
      }),
    initialPageParam: undefined as RunHistoryCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: historyOpen && Boolean(activeWorkflow),
  });

  const { t } = useTranslation();

  const runtime = historicalRun?.runtime as Record<string, unknown> | undefined;
  const restoredRun =
    typeof runtime?.threadId === 'string'
      ? { id: historicalRun!.id, threadId: runtime.threadId }
      : undefined;

  const createWorkflowForTeamRun = async () => {
    if (activeWorkflow) return activeWorkflow.id;
    if (!creatingWorkflow.current) {
      creatingWorkflow.current = createWorkflow(workflowDocument).catch(
        (error) => {
          creatingWorkflow.current = undefined;
          throw error;
        },
      );
    }
    const saved = await creatingWorkflow.current;
    setCreatedWorkflow(saved);
    setSavedDocument(workflowDocumentSnapshot);
    void queryClient.invalidateQueries({ queryKey: ['workflows'] });
    return saved.id;
  };

  const workflowRun = useWorkflowRun(
    activeWorkflow?.id ?? draftId,
    nodes,
    edges,
    workflowSettings,
    restoredRun,
    activeWorkflow?.releaseId,
    activeWorkflow?.version,
    isTeamMode() && !activeWorkflow ? createWorkflowForTeamRun : undefined,
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
      restoreWorkflowRunView(historicalRun.outputView, historicalRun),
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
      restoreHistoricalRun.setRunView(
        restoreWorkflowRunView(record.outputView, record),
      );
      restoreHistoricalRun.applyRunEvents(
        record.events.map(({ event }) => event as WorkflowRunEvent),
        { mode: workflowSettings.mode, nodes },
      );
      restoreHistoricalRun.setShowRunOutput(true);
      restoreHistoricalRun.setRunPanelOpen(true);
      setViewingHistoricalRunId(id);
    } catch (error) {
      toast.error(t('workflowEditor.history.loadOutputFailed'), {
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
      const saved = activeWorkflow
        ? await updateWorkflow(activeWorkflow.id, workflowDocument)
        : await (creatingWorkflow.current ?? createWorkflow(workflowDocument));
      if (!activeWorkflow) setCreatedWorkflow(saved);
      setSavedDocument(workflowDocumentSnapshot);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(
        activeWorkflow
          ? t('workflowEditor.saved')
          : t('workflowEditor.created'),
        {
          toasterId: 'global',
        },
      );
      if (!workflow) {
        void navigate(`/workflows/${saved.id}`, { replace: true });
      }
    } catch (error) {
      toast.error(t('workflowEditor.saveFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const publishCurrentWorkflow = async () => {
    if (!activeWorkflow || !version.trim() || !releaseNote.trim()) return;
    setIsPublishing(true);
    try {
      // Publication snapshots the current draft, so save unsaved canvas edits
      // before asking the server to create the immutable release.
      if (isDirty) {
        await updateWorkflow(activeWorkflow.id, workflowDocument);
        setSavedDocument(workflowDocumentSnapshot);
      }
      const release = await publishWorkflow(
        activeWorkflow.id,
        version.trim(),
        releaseNote.trim(),
      );
      setPublishOpen(false);
      setReleaseNote('');
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(
        t('workflowEditor.published', { version: release.version }),
        {
          toasterId: 'global',
        },
      );
    } catch (error) {
      toast.error(t('workflowEditor.publishFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsPublishing(false);
    }
  };
  const workflowModes = [
    { value: 'task', label: t('workflows.modes.task') },
    { value: 'chat', label: t('workflows.modes.chat') },
  ];

  return (
    <SidebarProvider className='relative flex size-full min-h-0! grow flex-row'>
      <WorkflowCanvas
        readOnly={readOnly}
        isRunning={workflowRun.isRunning}
        runningNodeId={workflowRun.runningNodeId}
        onRun={workflowRun.startRun}
        // A catalog release is immutable, but its pinned execution recipe is
        // safe to run. All editing controls remain governed by readOnly.
        canRun={!readOnly || allowRun}
        canvasContent={
          historyOpen && activeWorkflow ? (
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
                aria-label={t('workflowEditor.backToWorkflows')}
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
                    {t('workflowEditor.name')}
                  </FieldLabel>
                  <Input
                    id='workflow-name'
                    className='border-none'
                    value={workflowSettings.name}
                    disabled={readOnly}
                    onChange={(event) =>
                      updateWorkflowSettings({ name: event.target.value })
                    }
                  />
                </Field>
                <Field className='w-28'>
                  <FieldLabel className='sr-only' htmlFor='workflow-mode'>
                    {t('workflowEditor.runMode')}
                  </FieldLabel>
                  <Select
                    items={workflowModes}
                    value={workflowSettings.mode}
                    disabled={readOnly}
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
                        {workflowModes.map((item) => (
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
                <TabsList aria-label={t('workflowEditor.view')}>
                  <TabsTrigger value='canvas'>
                    {t('workflowEditor.canvas')}
                  </TabsTrigger>
                  <TabsTrigger value='history' disabled={!activeWorkflow}>
                    <HistoryIcon data-icon='inline-start' />
                    {t('workflowEditor.history.title')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className='flex items-center gap-2'>
              {!readOnly ? (
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2Icon data-icon='inline-start' />
                  {t('workflowEditor.moreSettings')}
                </Button>
              ) : null}
              {!readOnly ? (
                <Button
                  size='sm'
                  disabled={Boolean(activeWorkflow) && !isDirty}
                  onClick={() => void saveWorkflow()}
                >
                  <SaveIcon data-icon='inline-start' />
                  {activeWorkflow
                    ? t('workflowEditor.save')
                    : t('workflows.create')}
                </Button>
              ) : null}
              {isTeamMode() && activeWorkflow && !readOnly ? (
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    setReleaseNote(t('workflowEditor.releaseNoteDefault'));
                    setPublishOpen(true);
                  }}
                >
                  <UploadIcon data-icon='inline-start' />
                  {t('workflowEditor.publish')}
                </Button>
              ) : null}
            </div>
          </header>
        }
      >
        {!readOnly ? (
          <WorkflowNodeInspector
            node={selectedNode}
            workflowId={activeWorkflow?.id}
            executableNodes={nodes.filter((node) =>
              isExecutableNode(node.type),
            )}
            modelProfiles={modelCatalog}
            onClose={clearSelection}
            onDataChange={updateNodeData}
          />
        ) : null}
        {!readOnly ? (
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
        ) : null}
        {!readOnly || allowRun ? (
          <WorkflowRunPanel
            settings={workflowSettings}
            nodes={nodes}
            onRun={workflowRun.startWorkflowRun}
            onResume={workflowRun.resumeWorkflowRun}
            readOnly={Boolean(historicalRun || viewingHistoricalRunId)}
            onHistoricalClose={() => {
              if (historicalRun) {
                // This store outlives the history page. Reset it before returning
                // so a cached record still opens the drawer from its closed state.
                restoreHistoricalRun.setShowRunOutput(false);
                restoreHistoricalRun.setRunPanelOpen(false);
                void navigate(-1);
              } else {
                setViewingHistoricalRunId(undefined);
                restoreHistoricalRun.setRunPanelOpen(false);
              }
            }}
          />
        ) : null}
        <AlertDialog open={publishOpen} onOpenChange={setPublishOpen}>
          <AlertDialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg! gap-0 overflow-y-auto p-0'>
            <div className='via-background relative overflow-hidden border-b bg-linear-to-br from-violet-500/12 to-sky-500/10 px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
              <div className='absolute -top-12 -right-10 size-36 rounded-full bg-violet-500/10 blur-2xl' />
              <AlertDialogHeader className='relative grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-3 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
                <AlertDialogMedia className='mb-0 size-10 rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-700 shadow-sm dark:text-violet-300'>
                  <UploadIcon className='size-5' />
                </AlertDialogMedia>
                <div className='min-w-0 space-y-1.5'>
                  <AlertDialogTitle className='text-lg font-semibold tracking-tight'>
                    {t('workflowEditor.publishTitle')}
                  </AlertDialogTitle>
                  <AlertDialogDescription className='max-w-md text-sm leading-5'>
                    {t('workflowEditor.publishDescription')}
                  </AlertDialogDescription>
                </div>
              </AlertDialogHeader>
            </div>

            <div className='px-5 py-5 sm:px-6'>
              <FieldGroup className='gap-4'>
                <Field>
                  <FieldLabel htmlFor='workflow-release-version'>
                    {t('workflowEditor.version')}
                  </FieldLabel>
                  <Input
                    id='workflow-release-version'
                    value={version}
                    disabled={isPublishing}
                    placeholder='1.0.0'
                    className='font-mono'
                    onChange={(event) => setVersion(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor='workflow-release-note'>
                    {t('workflowEditor.releaseNote')}
                  </FieldLabel>
                  <Textarea
                    id='workflow-release-note'
                    value={releaseNote}
                    disabled={isPublishing}
                    placeholder={t('workflowEditor.releaseNotePlaceholder')}
                    className='min-h-24 resize-y'
                    onChange={(event) => setReleaseNote(event.target.value)}
                  />
                </Field>
              </FieldGroup>
            </div>
            <AlertDialogFooter className='mx-0 mb-0 px-5 py-4 sm:px-6'>
              <AlertDialogCancel disabled={isPublishing}>
                {t('workflowEditor.cancel')}
              </AlertDialogCancel>
              <Button
                disabled={
                  isPublishing || !version.trim() || !releaseNote.trim()
                }
                onClick={() => void publishCurrentWorkflow()}
              >
                {isPublishing ? <Spinner data-icon='inline-start' /> : null}
                {t('workflowEditor.publish')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
