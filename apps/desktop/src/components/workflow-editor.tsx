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
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  SidebarProvider,
  SidebarTrigger,
  Textarea,
} from '@workspace/ui/components';
import {
  ArrowLeftIcon,
  SaveIcon,
  Settings2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
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
  autoStartRun?: boolean;
};

function ReviewMarkdown({ content }: { content: string }) {
  return (
    <Markdown
      components={{
        h1: ({ children }) => (
          <h1 className='font-heading text-xl font-semibold tracking-tight'>
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className='font-heading mt-6 text-lg font-semibold first:mt-0'>
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className='mt-5 text-sm font-semibold'>{children}</h3>
        ),
        li: ({ children }) => <li className='leading-6'>{children}</li>,
        p: ({ children }) => <p className='leading-6'>{children}</p>,
        ul: ({ children }) => (
          <ul className='list-disc space-y-1 pl-5'>{children}</ul>
        ),
      }}
    >
      {content}
    </Markdown>
  );
}

function HumanReviewContent({
  review,
  edits,
  onEdit,
}: {
  review: Record<string, unknown> | undefined;
  edits: Record<string, string>;
  onEdit: (key: string, value: string) => void;
}) {
  const contentKey =
    typeof review?.contentKey === 'string' ? review.contentKey : undefined;
  const content = review?.content;
  const context = review?.context;
  const editable = review?.editable === true;

  return (
    <div className='max-h-[calc(88vh-12rem)] min-h-0 overflow-y-auto'>
      <section className='bg-muted/20 rounded-lg border p-5'>
        <div className='mb-4 flex items-center gap-2'>
          <Badge variant='secondary'>审核内容</Badge>
          {contentKey ? <code className='text-xs'>{contentKey}</code> : null}
        </div>
        {editable && contentKey && typeof content === 'string' ? (
          <Textarea
            value={edits[contentKey] ?? content}
            onChange={(event) => onEdit(contentKey, event.target.value)}
            className='min-h-72 font-mono text-sm leading-6'
          />
        ) : typeof content === 'string' ? (
          <ReviewMarkdown content={content} />
        ) : (
          <pre className='bg-muted max-h-[calc(88vh-16rem)] overflow-auto rounded-md p-3 text-xs'>
            {JSON.stringify(content ?? null, null, 2)}
          </pre>
        )}
      </section>
      {context && typeof context === 'object' ? (
        <section className='bg-muted/20 mt-4 rounded-lg border p-5'>
          <div className='mb-4 flex items-center gap-2'>
            <Badge variant='secondary'>补充上下文</Badge>
          </div>
          <pre className='bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs'>
            {JSON.stringify(context, null, 2)}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

function WorkflowEditor({ workflow, autoStartRun }: WorkflowEditorProps) {
  const [draftDocument] = useState<WorkflowDocument>(() =>
    createWorkflowDocument(),
  );
  const [workflowStore] = useState(() =>
    createWorkflowStore(workflow?.document ?? draftDocument),
  );

  return (
    <WorkflowStoreProvider store={workflowStore}>
      <WorkflowEditorContent workflow={workflow} autoStartRun={autoStartRun} />
    </WorkflowStoreProvider>
  );
}

function WorkflowEditorContent({
  workflow,
  autoStartRun,
}: WorkflowEditorProps) {
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [savedDocument, setSavedDocument] = useState<string>(() =>
    workflow ? JSON.stringify(workflow.document) : '',
  );
  const [humanReviewEdits, setHumanReviewEdits] = useState<{
    nodeId: string | undefined;
    values: Record<string, string>;
  }>({ nodeId: undefined, values: {} });
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

  const workflowRun = useWorkflowRun(
    workflow?.id ?? draftId,
    nodes,
    edges,
    workflowSettings,
  );

  const humanReviewNodeId =
    typeof workflowRun.humanReview?.nodeId === 'string'
      ? workflowRun.humanReview.nodeId
      : undefined;
  const currentHumanReviewEdits =
    humanReviewEdits.nodeId === humanReviewNodeId
      ? humanReviewEdits.values
      : {};

  useEffect(() => {
    if (!autoStartRun || autoStartHandled.current) return;
    autoStartHandled.current = true;
    workflowRun.startRun();
  }, [autoStartRun, workflowRun]);

  const askUserQuestionOptions = Array.isArray(
    workflowRun.askUserQuestion?.options,
  )
    ? workflowRun.askUserQuestion.options.flatMap((option) => {
        if (typeof option !== 'object' || option === null) return [];
        const value = option as Record<string, unknown>;
        if (typeof value.id !== 'string' || typeof value.label !== 'string')
          return [];
        return [
          {
            id: value.id,
            label: value.label,
            description:
              typeof value.description === 'string'
                ? value.description
                : undefined,
          },
        ];
      })
    : [];

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
                  Allow {(workflowRun.toolApproval?.name as string) ?? 'Tool'}{' '}
                  to run?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {typeof workflowRun.toolApproval?.description === 'string'
                    ? workflowRun.toolApproval.description
                    : 'The Agent requested a Tool App execution.'}
                </AlertDialogDescription>
                <div className='flex flex-wrap gap-1.5 pt-1'>
                  <Badge variant='outline'>
                    Source:{' '}
                    {(workflowRun.toolApproval?.sourceName as string) ??
                      (workflowRun.toolApproval?.source as string) ??
                      'Tool App'}
                  </Badge>
                  <Badge variant='secondary'>
                    Risk:{' '}
                    {(workflowRun.toolApproval?.riskLevel as string) ??
                      'unknown'}
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
          <AlertDialogContent className='max-h-[88vh] w-[min(94vw,72rem)]! max-w-none!'>
            <AlertDialogHeader className='grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-2 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
              <AlertDialogMedia className='mb-0 size-8'>
                <ShieldCheckIcon />
              </AlertDialogMedia>
              <div className='min-w-0 space-y-1.5'>
                <AlertDialogTitle>
                  {(workflowRun.humanReview?.title as string) ??
                    'Human review required'}
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
            <HumanReviewContent
              review={workflowRun.humanReview}
              edits={currentHumanReviewEdits}
              onEdit={(key, value) =>
                setHumanReviewEdits((current) => ({
                  nodeId: humanReviewNodeId,
                  values:
                    current.nodeId === humanReviewNodeId
                      ? { ...current.values, [key]: value }
                      : { [key]: value },
                }))
              }
            />
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
                onClick={() =>
                  void workflowRun.resolvePendingHumanReview(
                    true,
                    currentHumanReviewEdits,
                  )
                }
              >
                {workflowRun.isResolvingHumanReview
                  ? 'Saving decision…'
                  : 'Approve & continue'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={Boolean(workflowRun.askUserQuestion)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {(workflowRun.askUserQuestion?.title as string) ??
                  'Choose an option'}
              </AlertDialogTitle>
              {typeof workflowRun.askUserQuestion?.description === 'string' ? (
                <AlertDialogDescription>
                  {workflowRun.askUserQuestion.description}
                </AlertDialogDescription>
              ) : null}
            </AlertDialogHeader>
            <Questionnaire
              items={[
                {
                  name: 'answer',
                  required: true,
                  choices: askUserQuestionOptions.map((option) => ({
                    value: option.id,
                  })),
                },
              ]}
              onSubmit={(event) => {
                event.preventDefault();
                const answer = new FormData(event.currentTarget).get('answer');
                if (typeof answer === 'string')
                  void workflowRun.resolvePendingAskUserQuestion(answer);
              }}
            >
              <QuestionnaireItem name='answer' required>
                <QuestionnaireTitle className='sr-only'>
                  Available options
                </QuestionnaireTitle>
                <QuestionnaireChoices>
                  {askUserQuestionOptions.map((option) => (
                    <QuestionnaireChoice key={option.id} value={option.id}>
                      <span>{option.label}</span>
                      {option.description ? (
                        <QuestionnaireChoiceDescription>
                          {option.description}
                        </QuestionnaireChoiceDescription>
                      ) : null}
                    </QuestionnaireChoice>
                  ))}
                </QuestionnaireChoices>
                <QuestionnaireError />
              </QuestionnaireItem>
              <QuestionnaireActions>
                <QuestionnaireSubmit
                  disabled={workflowRun.isResolvingAskUserQuestion}
                >
                  {workflowRun.isResolvingAskUserQuestion
                    ? 'Saving answer…'
                    : 'Continue'}
                </QuestionnaireSubmit>
              </QuestionnaireActions>
            </Questionnaire>
          </AlertDialogContent>
        </AlertDialog>
      </WorkflowCanvas>
    </SidebarProvider>
  );
}

export { WorkflowEditor };
