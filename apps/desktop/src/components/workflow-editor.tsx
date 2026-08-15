import { useQuery } from '@tanstack/react-query';
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
} from '@workspace/ui/components';
import { SaveIcon, Settings2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { WorkflowNodeInspector } from '@/components/workflow-node-inspector';
import { WorkflowRunPanel } from '@/components/workflow-run-panel';
import { WorkflowSettingsPanel } from '@/components/workflow-settings';
import { getModelCatalog } from '@/services/cmd';
import {
  loadWorkflowDocument,
  saveWorkflowDocument,
  toWorkflowDocument,
} from '@/services/workflow';
import { useWorkflowStore } from '@/stores';

import { useWorkflowRun } from './workflow-editor/use-workflow-run';
import { WorkflowCanvas } from './workflow-editor/workflow-canvas';

const WORKFLOW_MODE = [
  { value: 'task', label: 'Task' },
  { value: 'chat', label: 'Chat' },
];

function WorkflowEditor() {
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId);
  const workflowSettings = useWorkflowStore((state) => state.settings);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const updateWorkflowSettings = useWorkflowStore(
    (state) => state.updateSettings,
  );
  const replaceWorkflow = useWorkflowStore((state) => state.replaceWorkflow);
  const clearSelection = useWorkflowStore((state) => state.clearSelection);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savedDocument, setSavedDocument] = useState(() =>
    JSON.stringify(toWorkflowDocument(nodes, edges, workflowSettings)),
  );

  const workflowDocument = toWorkflowDocument(nodes, edges, workflowSettings);
  const workflowDocumentSnapshot = JSON.stringify(workflowDocument);
  const isDirty = workflowDocumentSnapshot !== savedDocument;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const { data: modelCatalog } = useQuery({
    queryKey: ['modelCatalog'],
    queryFn: getModelCatalog,
  });
  const workflowRun = useWorkflowRun(nodes, edges, workflowSettings);

  useEffect(() => {
    const saved = loadWorkflowDocument();
    if (!saved) return;
    replaceWorkflow(saved);
    setSavedDocument(JSON.stringify(saved));
  }, [replaceWorkflow]);

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
        const { undo, pastStates } = useWorkflowStore.temporal.getState();
        if (pastStates.length > 0) undo();
      }
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        const { redo, futureStates } = useWorkflowStore.temporal.getState();
        if (futureStates.length > 0) redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const saveWorkflow = () => {
    try {
      saveWorkflowDocument(workflowDocument);
      setSavedDocument(workflowDocumentSnapshot);
      toast.success('Workflow saved', { toasterId: 'global' });
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
              <Button size='sm' disabled={!isDirty} onClick={saveWorkflow}>
                <SaveIcon data-icon='inline-start' />
                Save
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
          open={workflowRun.runPanelOpen}
          settings={workflowSettings}
          run={workflowRun.runView}
          isRunning={workflowRun.isRunning}
          showOutput={workflowRun.showRunOutput}
          onOpenChange={workflowRun.setRunPanelOpen}
          onRun={workflowRun.startWorkflowRun}
          onRunAgain={() => {
            if (workflowRun.lastRunInput) {
              workflowRun.startWorkflowRun(workflowRun.lastRunInput);
            }
          }}
        />
      </WorkflowCanvas>
    </SidebarProvider>
  );
}

export { WorkflowEditor };
