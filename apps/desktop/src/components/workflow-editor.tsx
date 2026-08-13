import { useMutation, useQuery } from '@tanstack/react-query';
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
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  Spinner,
} from '@workspace/ui/components';
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  Play,
  Redo2Icon,
  SaveIcon,
  Settings2Icon,
  Undo2Icon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from 'zustand';

import {
  AgentNode,
  EndNode,
  GroupNode,
  IfElseNode,
  RemoteAgentNode,
  StartNode,
  SwitchNode,
} from '@/components/nodes';
import { WorkflowNodeInspector } from '@/components/workflow-node-inspector';
import { WorkflowRunPanel } from '@/components/workflow-run-panel';
import { WorkflowSettingsPanel } from '@/components/workflow-settings';
import { WorkflowSidebar } from '@/components/workflow-sidebar';
import { getModelCatalog } from '@/services/cmd';
import {
  loadWorkflowDocument,
  runWorkflow,
  saveWorkflowDocument,
  toWorkflowDocument,
  toWorkflowDsl,
  type WorkflowRunEvent,
  type WorkflowRunView,
} from '@/services/workflow';
import { useWorkflowStore } from '@/stores';

const nodeTypes = {
  // basic nodes
  agent: AgentNode,
  remote_agent: RemoteAgentNode,
  // controls
  start: StartNode,
  end: EndNode,
  if_else: IfElseNode,
  switch: SwitchNode,
  group: GroupNode,
};

const WORKFLOW_MODE = [
  {
    value: 'task',
    label: 'Task',
  },
  {
    value: 'chat',
    label: 'Chat',
  },
];

const initialRunView: WorkflowRunView = {
  status: 'idle',
  nodes: [],
  messages: [],
  thoughts: [],
};

function runningNode(
  nodes: WorkflowRunView['nodes'],
  nodeId: string,
): WorkflowRunView['nodes'] {
  const existing = nodes.find((node) => node.id === nodeId);
  if (existing) {
    return nodes.map((node) =>
      node.id === nodeId ? { ...node, status: 'running' } : node,
    );
  }

  return [...nodes, { id: nodeId, status: 'running' }];
}

function finishNode(
  nodes: WorkflowRunView['nodes'],
  nodeId: string,
  durationMs?: number,
  status: 'completed' | 'failed' = 'completed',
): WorkflowRunView['nodes'] {
  const existing = nodes.find((node) => node.id === nodeId);
  if (existing) {
    return nodes.map((node) =>
      node.id === nodeId ? { ...node, status, durationMs } : node,
    );
  }

  return [{ id: nodeId, status, durationMs }, ...nodes];
}

function startThought(
  thoughts: WorkflowRunView['thoughts'],
  nodeId: string,
  turnId?: string,
): WorkflowRunView['thoughts'] {
  return [
    ...thoughts,
    {
      id: crypto.randomUUID(),
      nodeId,
      status: 'running',
      turnId,
    },
  ];
}

function finishThought(
  thoughts: WorkflowRunView['thoughts'],
  nodeId: string,
  durationMs?: number,
  status: 'completed' | 'failed' = 'completed',
): WorkflowRunView['thoughts'] {
  for (let index = thoughts.length - 1; index >= 0; index -= 1) {
    const thought = thoughts[index];
    if (thought.nodeId === nodeId && thought.status === 'running') {
      return thoughts.map((item, itemIndex) =>
        itemIndex === index ? { ...item, status, durationMs } : item,
      );
    }
  }

  return thoughts;
}

function settleThoughts(
  thoughts: WorkflowRunView['thoughts'],
  status: 'completed' | 'failed' = 'completed',
): WorkflowRunView['thoughts'] {
  return thoughts.map((thought) =>
    thought.status === 'running' ? { ...thought, status } : thought,
  );
}

function createNodeData(type: WorkflowNodeType) {
  switch (type) {
    case 'agent':
      return {
        name: 'New agent',
        modelProfileId: '',
        description: 'Describe this agent’s responsibility',
        instruction: '',
      };
    case 'remote_agent':
      return {
        name: 'New remote agent',
        url: 'https://',
        description: 'Describe this remote agent',
      };
    case 'if_else':
      return {
        label: 'If / Else',
        selector: { field: 'approved' },
      };
    case 'switch':
      return {
        label: 'Switch',
        selector: { field: 'route' },
        cases: [
          { id: 'case-1', value: 'case_1', label: 'Case 1' },
          { id: 'case-2', value: 'case_2', label: 'Case 2' },
        ],
        defaultLabel: 'Default',
      };
    case 'start':
      return { label: 'Start' };
    case 'end':
      return { label: 'End' };
    case 'group':
      return { label: 'New group' };
  }
}

function getNodeDimension(
  node: Node,
  dimension: 'width' | 'height',
): number | undefined {
  const measured = node.measured?.[dimension];
  if (typeof measured === 'number') {
    return measured;
  }

  const explicit = node[dimension];
  if (typeof explicit === 'number') {
    return explicit;
  }

  const styled = node.style?.[dimension];
  return typeof styled === 'number' ? styled : undefined;
}

function findGroupAtPosition(
  nodes: Node[],
  position: { x: number; y: number },
  excludedNodeId?: string,
) {
  return [...nodes].reverse().find((node) => {
    if (node.type !== 'group' || node.id === excludedNodeId) {
      return false;
    }

    const width = getNodeDimension(node, 'width');
    const height = getNodeDimension(node, 'height');
    if (!width || !height) {
      return false;
    }

    return (
      position.x >= node.position.x &&
      position.x <= node.position.x + width &&
      position.y >= node.position.y &&
      position.y <= node.position.y + height
    );
  });
}

/**
 * React Flow processes sub-flow nodes in array order: every parent must appear
 * before its children. Keep that invariant whenever a node changes groups.
 */
function sortNodesParentFirst(nodes: Node[]) {
  const parentIds = new Set(
    nodes.flatMap((node) => (node.parentId ? [node.parentId] : [])),
  );

  return [
    ...nodes.filter((node) => parentIds.has(node.id)),
    ...nodes.filter((node) => !parentIds.has(node.id)),
  ];
}

function getAbsolutePosition(node: Node, nodes: Node[]) {
  if (!node.parentId) {
    return node.position;
  }

  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  return parent
    ? {
        x: node.position.x + parent.position.x,
        y: node.position.y + parent.position.y,
      }
    : node.position;
}

function WorkflowEditor() {
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId);
  const workflowSettings = useWorkflowStore((state) => state.settings);
  const canUndo = useStore(
    useWorkflowStore.temporal,
    (state) => state.pastStates.length > 0,
  );
  const canRedo = useStore(
    useWorkflowStore.temporal,
    (state) => state.futureStates.length > 0,
  );
  const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
  const onEdgesChange = useWorkflowStore((state) => state.onEdgesChange);
  const addNode = useWorkflowStore((state) => state.addNode);
  const addConnection = useWorkflowStore((state) => state.addConnection);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const updateWorkflowSettings = useWorkflowStore(
    (state) => state.updateSettings,
  );
  const replaceWorkflow = useWorkflowStore((state) => state.replaceWorkflow);
  const setNodes = useWorkflowStore((state) => state.setNodes);
  const setSelectedNodeId = useWorkflowStore(
    (state) => state.setSelectedNodeId,
  );
  const clearSelection = useWorkflowStore((state) => state.clearSelection);
  const startNodeDrag = useWorkflowStore((state) => state.startNodeDrag);
  const finishNodeDrag = useWorkflowStore((state) => state.finishNodeDrag);

  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);
  const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [showRunOutput, setShowRunOutput] = useState(false);
  const [runView, setRunView] = useState<WorkflowRunView>(initialRunView);
  const [lastRunInput, setLastRunInput] = useState<Record<string, unknown>>();
  const chatThreadId = useRef<string | undefined>(undefined);
  const chatTurnId = useRef<string | undefined>(undefined);
  const [savedDocument, setSavedDocument] = useState(() =>
    JSON.stringify(toWorkflowDocument(nodes, edges, workflowSettings)),
  );

  const workflowDocument = toWorkflowDocument(nodes, edges, workflowSettings);
  const workflowDocumentSnapshot = JSON.stringify(workflowDocument);
  const isDirty = workflowDocumentSnapshot !== savedDocument;

  useEffect(() => {
    const saved = loadWorkflowDocument();
    if (!saved) return;

    replaceWorkflow(saved);
    setSavedDocument(JSON.stringify(saved));
  }, [replaceWorkflow]);

  const { data: modelCatalog } = useQuery({
    queryKey: ['modelCatalog'],
    queryFn: getModelCatalog,
  });

  const handleRunEvent = (event: WorkflowRunEvent) => {
    switch (event.type) {
      case 'node_start':
        setRunningNodeId(event.node);
        setRunView((current) => ({
          ...current,
          activeNodeId: event.node,
          nodes: runningNode(current.nodes, event.node),
          thoughts: startThought(
            current.thoughts,
            event.node,
            chatTurnId.current,
          ),
        }));
        return;
      case 'node_end':
        setRunView((current) => ({
          ...current,
          activeNodeId:
            current.activeNodeId === event.node
              ? undefined
              : current.activeNodeId,
          nodes: finishNode(current.nodes, event.node, event.duration_ms),
          thoughts: finishThought(
            current.thoughts,
            event.node,
            event.duration_ms,
          ),
          messages: current.messages.map((message) =>
            message.nodeId === event.node
              ? { ...message, isStreaming: false }
              : message,
          ),
        }));
        return;
      case 'message':
        if (!event.content) return;
        setRunView((current) => {
          const lastMessage = current.messages.at(-1);
          if (lastMessage?.nodeId === event.node && lastMessage.isStreaming) {
            return {
              ...current,
              messages: [
                ...current.messages.slice(0, -1),
                {
                  ...lastMessage,
                  content: lastMessage.content + event.content,
                  isStreaming: !event.is_final,
                  turnId: chatTurnId.current,
                },
              ],
            };
          }

          return {
            ...current,
            messages: [
              ...current.messages,
              {
                id: crypto.randomUUID(),
                nodeId: event.node,
                content: event.content,
                isStreaming: !event.is_final,
                role: 'assistant',
                turnId: chatTurnId.current,
              },
            ],
          };
        });
        return;
      case 'done':
        setRunView((current) => ({
          ...current,
          status: 'completed',
          activeNodeId: undefined,
          endedAt: Date.now(),
          totalSteps: event.total_steps,
          finalState: event.state,
          thoughts: settleThoughts(current.thoughts),
          messages: current.messages.map((message) => ({
            ...message,
            isStreaming: false,
          })),
        }));
        return;
      case 'error':
        setRunView((current) => ({
          ...current,
          status: 'failed',
          activeNodeId: undefined,
          endedAt: Date.now(),
          error: event.message,
          nodes: event.node
            ? finishNode(current.nodes, event.node, undefined, 'failed')
            : current.nodes,
          thoughts: event.node
            ? finishThought(current.thoughts, event.node, undefined, 'failed')
            : current.thoughts,
          messages: current.messages.map((message) => ({
            ...message,
            isStreaming: false,
          })),
        }));
        return;
      case 'interrupted':
        setRunView((current) => ({
          ...current,
          status: 'interrupted',
          activeNodeId: undefined,
          endedAt: Date.now(),
          error: event.message,
          thoughts: settleThoughts(current.thoughts, 'failed'),
          messages: current.messages.map((message) => ({
            ...message,
            isStreaming: false,
          })),
        }));
        return;
      default:
        return;
    }
  };

  const runMutation = useMutation({
    mutationFn: (initialState: Record<string, unknown>) =>
      runWorkflow(
        toWorkflowDsl(nodes, edges, workflowSettings),
        initialState,
        workflowSettings.mode === 'chat'
          ? chatThreadId.current
          : crypto.randomUUID(),
        handleRunEvent,
      ),
    onSuccess: (result) => {
      setRunView((current) => ({
        ...current,
        status: 'completed',
        activeNodeId: undefined,
        endedAt: current.endedAt ?? Date.now(),
        finalState: result.state,
        thoughts: settleThoughts(current.thoughts),
        messages: current.messages.map((message) => ({
          ...message,
          isStreaming: false,
        })),
      }));
      const lastNode = result.state['workflow.last_node'];
      toast.success('Workflow completed', {
        toasterId: 'global',
        description:
          typeof lastNode === 'string'
            ? `Finished at node ${lastNode}.`
            : undefined,
      });
    },
    onError: (error) => {
      setRunView((current) => ({
        ...current,
        status: 'failed',
        activeNodeId: undefined,
        endedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        thoughts: settleThoughts(current.thoughts, 'failed'),
        messages: current.messages.map((message) => ({
          ...message,
          isStreaming: false,
        })),
      }));
      toast.error('Workflow failed', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    },
    onSettled: () => setRunningNodeId(null),
  });

  // Keyboard event handlers for modifier key and undo/redo
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

      if (!event.metaKey && !event.ctrlKey) {
        return;
      }

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

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  const addPaletteNode = (type: WorkflowNodeType, x: number, y: number) => {
    if (!reactFlowInstance) {
      return;
    }

    const position = reactFlowInstance.screenToFlowPosition({
      x,
      y,
    });
    const group =
      type === 'group' ? undefined : findGroupAtPosition(nodes, position);
    const newNode: Node = {
      id: crypto.randomUUID(),
      type,
      position: group
        ? {
            x: position.x - group.position.x,
            y: position.y - group.position.y,
          }
        : position,
      data: createNodeData(type),
      ...(type === 'group' && {
        // React Flow raises selected nodes by 1000. Keep groups below edges
        // even when selected, so nodes and connections remain interactive.
        zIndex: -1001,
        style: { width: 480, height: 320, backgroundColor: 'transparent' },
      }),
      ...(group && { parentId: group.id }),
    };
    addNode(newNode);
  };

  const onNodeDragStart = () => {
    startNodeDrag();
  };

  const onNodeDragStop = (_: unknown, draggedNode: Node) => {
    if (draggedNode.type === 'group') {
      finishNodeDrag();
      return;
    }

    const absolutePosition = getAbsolutePosition(draggedNode, nodes);
    const group = findGroupAtPosition(nodes, absolutePosition, draggedNode.id);
    if (group?.id !== draggedNode.parentId) {
      const updatedNodes = nodes.map((node) =>
        node.id !== draggedNode.id
          ? node
          : group
            ? {
                ...node,
                parentId: group.id,
                position: {
                  x: absolutePosition.x - group.position.x,
                  y: absolutePosition.y - group.position.y,
                },
              }
            : {
                ...node,
                parentId: undefined,
                extent: undefined,
                position: absolutePosition,
              },
      );
      setNodes(sortNodesParentFirst(updatedNodes));
    }
    finishNodeDrag();
  };

  const onNodeDataChange = (nodeId: string, patch: Record<string, unknown>) => {
    updateNodeData(nodeId, patch);
  };

  const closeInspector = () => {
    clearSelection();
  };

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

  const startRun = () => {
    if (workflowSettings.mode === 'chat') {
      chatThreadId.current = crypto.randomUUID();
      setRunView(initialRunView);
      setRunPanelOpen(true);
      return;
    }
    if (
      workflowSettings.mode === 'task' &&
      workflowSettings.inputSchema.fields.length === 0
    ) {
      startWorkflowRun({});
      return;
    }
    setShowRunOutput(false);
    setRunPanelOpen(true);
  };

  const startWorkflowRun = (initialState: Record<string, unknown>) => {
    const turnId =
      workflowSettings.mode === 'chat' ? crypto.randomUUID() : undefined;
    chatTurnId.current = turnId;
    const inputContent =
      typeof initialState.input === 'string'
        ? initialState.input
        : (JSON.stringify(initialState.input ?? '') ?? '');

    setLastRunInput(initialState);
    setRunView((current) =>
      workflowSettings.mode === 'chat'
        ? {
            ...current,
            status: 'running',
            startedAt: Date.now(),
            endedAt: undefined,
            activeNodeId: undefined,
            finalState: undefined,
            error: undefined,
            nodes: [],
            messages: [
              ...current.messages,
              {
                id: crypto.randomUUID(),
                nodeId: 'You',
                content: inputContent,
                isStreaming: false,
                role: 'user',
                turnId,
              },
            ],
          }
        : {
            status: 'running',
            startedAt: Date.now(),
            nodes: [],
            messages: [],
            thoughts: [],
          },
    );
    setRunPanelOpen(true);
    setShowRunOutput(true);
    runMutation.mutate(initialState);
  };

  return (
    <SidebarProvider className='relative flex size-full min-h-0! grow flex-row'>
      <WorkflowSidebar onNodeDrop={addPaletteNode} />
      <SidebarInset>
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
        <div className='flex flex-1'>
          <ReactFlow
            colorMode='dark'
            fitView
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={setReactFlowInstance}
            onConnect={addConnection}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onSelectionChange={({ nodes: selectedNodes }) =>
              setSelectedNodeId(selectedNodes.at(-1)?.id ?? null)
            }
          >
            <MiniMap />
            <Controls />
            <Background className='dark:bg-background' />
            <Panel position='top-left'>
              <div className='bg-background z-10 flex gap-1 rounded-md border p-1 shadow-sm'>
                <Button
                  variant='ghost'
                  size='icon-sm'
                  aria-label='Undo'
                  title='Undo (Ctrl/Cmd + Z)'
                  disabled={!canUndo}
                  onClick={() => {
                    const { undo, pastStates } =
                      useWorkflowStore.temporal.getState();
                    if (pastStates.length > 0) undo();
                  }}
                >
                  <Undo2Icon />
                </Button>
                <Button
                  variant='ghost'
                  size='icon-sm'
                  aria-label='Redo'
                  title='Redo (Ctrl/Cmd + Shift + Z)'
                  disabled={!canRedo}
                  onClick={() => {
                    const { redo, futureStates } =
                      useWorkflowStore.temporal.getState();
                    if (futureStates.length > 0) redo();
                  }}
                >
                  <Redo2Icon />
                </Button>
              </div>
            </Panel>
            <Panel position='top-right'>
              <div>
                <Button
                  variant='secondary'
                  disabled={runMutation.isPending}
                  onClick={startRun}
                >
                  {runMutation.isPending ? (
                    <Spinner data-icon='inline-start' />
                  ) : (
                    <Play data-icon='inline-start' />
                  )}
                  {runMutation.isPending
                    ? runningNodeId
                      ? `Running ${runningNodeId}…`
                      : 'Running…'
                    : 'Run'}
                </Button>
              </div>
            </Panel>
          </ReactFlow>
        </div>
        <WorkflowNodeInspector
          node={selectedNode}
          modelProfiles={modelCatalog}
          onClose={closeInspector}
          onDataChange={onNodeDataChange}
        />
        <WorkflowSettingsPanel
          open={settingsOpen}
          settings={workflowSettings}
          onOpenChange={setSettingsOpen}
          onSettingsChange={updateWorkflowSettings}
        />
        <WorkflowRunPanel
          open={runPanelOpen}
          settings={workflowSettings}
          run={runView}
          isRunning={runMutation.isPending}
          showOutput={showRunOutput}
          onOpenChange={setRunPanelOpen}
          onRun={startWorkflowRun}
          onRunAgain={() => {
            if (lastRunInput) startWorkflowRun(lastRunInput);
          }}
        />
      </SidebarInset>
    </SidebarProvider>
  );
}

export { WorkflowEditor };
