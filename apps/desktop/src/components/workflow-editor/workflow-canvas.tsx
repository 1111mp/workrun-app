import { Button, SidebarInset, Spinner } from '@workspace/ui/components';
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { TFunction } from 'i18next';
import { Play, Redo2Icon, Undo2Icon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';

import {
  AgentNode,
  AskUserQuestionNode,
  CodeActAgentNode,
  EndNode,
  GroupNode,
  HumanReviewNode,
  IfElseNode,
  ProcessNode,
  RemoteAgentNode,
  StartNode,
  SubworkflowNode,
  SwitchNode,
  TerminateNode,
} from '@/components/nodes';
import { WorkflowSidebar } from '@/components/workflow-sidebar';
import { useWorkflowStoreApi, useWorkrunStore } from '@/stores';

const nodeTypes = {
  agent: AgentNode,
  codeact_agent: CodeActAgentNode,
  remote_agent: RemoteAgentNode,
  process: ProcessNode,
  start: StartNode,
  end: EndNode,
  if_else: IfElseNode,
  switch: SwitchNode,
  group: GroupNode,
  human_review: HumanReviewNode,
  ask_user_question: AskUserQuestionNode,
  subworkflow: SubworkflowNode,
  terminate: TerminateNode,
};

function createNodeData(type: WorkflowNodeType, t: TFunction) {
  switch (type) {
    case 'agent':
      return {
        name: t('workflowEditor.defaults.newAgent'),
        modelProfileId: '',
        description: t('workflowEditor.defaults.agentDescription'),
        instruction: '',
        outputKey: '',
        temperature: undefined,
        topP: undefined,
        skillRefs: [],
        toolIds: [],
        maxToolCalls: 8,
        toolTimeoutSeconds: 60,
      };
    case 'codeact_agent':
      return {
        name: t('workflowEditor.defaults.newCodeActAgent'),
        modelProfileId: '',
        description: t('workflowEditor.defaults.codeActDescription'),
        instruction: '',
        toolIds: [],
        maxIterations: 8,
        maxToolCalls: 8,
        toolTimeoutSeconds: 60,
        maxScriptDurationSeconds: 5,
        maxScriptMemoryMiB: 256,
        systemClock: true,
        mounts: [],
        environment: [],
      };
    case 'remote_agent':
      return {
        name: t('workflowEditor.defaults.newRemoteAgent'),
        url: 'https://',
        description: t('workflowEditor.defaults.remoteAgentDescription'),
      };
    case 'process':
      return {
        name: t('workflowEditor.defaults.newApp'),
        processNodeId: '',
        description: t('workflowEditor.defaults.appDescription'),
      };
    case 'subworkflow':
      return {
        workflowId: '',
        workflowName: '',
      };
    case 'terminate':
      return { label: t('workflowEditor.nodes.terminate') };
    case 'if_else':
      return {
        label: t('workflowEditor.nodes.ifElse'),
        conditions: {
          true: { label: t('workflowEditor.nodes.true'), condition: '' },
          false: { label: t('workflowEditor.nodes.false'), condition: '' },
        },
      };
    case 'switch':
      return {
        label: t('workflowEditor.nodes.switch'),
        cases: [
          {
            id: 'case-1',
            label: t('workflowEditor.nodes.case', { index: 1 }),
            condition: '',
          },
          {
            id: 'case-2',
            label: t('workflowEditor.nodes.case', { index: 2 }),
            condition: '',
          },
        ],
        defaultCase: {
          label: t('workflowEditor.nodes.default'),
          condition: '',
        },
      };
    case 'human_review':
      return {
        title: t('workflowEditor.nodes.humanReview'),
        description: t('workflowEditor.defaults.humanReviewDescription'),
        contentKey: '',
        contextKeys: [],
        editable: false,
      };
    case 'ask_user_question':
      return {
        title: t('workflowEditor.defaults.chooseAnOption'),
        description: t('workflowEditor.defaults.askUserQuestionDescription'),
        options: [
          {
            id: 'option-1',
            label: t('workflowEditor.nodes.option', { index: 1 }),
          },
          {
            id: 'option-2',
            label: t('workflowEditor.nodes.option', { index: 2 }),
          },
        ],
      };
    case 'start':
      return { label: t('workflowEditor.nodes.start') };
    case 'end':
      return { label: t('workflowEditor.nodes.end') };
    case 'group':
      return { label: t('workflowEditor.defaults.newGroup') };
  }
}

function getNodeDimension(node: Node, dimension: 'width' | 'height') {
  const measured = node.measured?.[dimension];
  if (typeof measured === 'number') return measured;
  const explicit = node[dimension];
  if (typeof explicit === 'number') return explicit;
  const styled = node.style?.[dimension];
  return typeof styled === 'number' ? styled : undefined;
}

function findGroupAtPosition(
  nodes: Node[],
  position: { x: number; y: number },
  excludedNodeId?: string,
) {
  return [...nodes].reverse().find((node) => {
    if (node.type !== 'group' || node.id === excludedNodeId) return false;
    const width = getNodeDimension(node, 'width');
    const height = getNodeDimension(node, 'height');
    if (!width || !height) return false;
    return (
      position.x >= node.position.x &&
      position.x <= node.position.x + width &&
      position.y >= node.position.y &&
      position.y <= node.position.y + height
    );
  });
}

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
  if (!node.parentId) return node.position;
  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  return parent
    ? {
        x: node.position.x + parent.position.x,
        y: node.position.y + parent.position.y,
      }
    : node.position;
}

type WorkflowCanvasProps = {
  canvasContent?: ReactNode;
  children: ReactNode;
  header: ReactNode;
  isRunning: boolean;
  runningNodeId: string | null;
  onRun: () => void;
  readOnly?: boolean;
};

function WorkflowCanvas({
  children,
  canvasContent,
  header,
  isRunning,
  runningNodeId,
  onRun,
  readOnly = false,
}: WorkflowCanvasProps) {
  const { t } = useTranslation();
  const workflowStore = useWorkflowStoreApi();
  const nodes = useStore(workflowStore, (state) => state.nodes);
  const edges = useStore(workflowStore, (state) => state.edges);
  const colorMode = useWorkrunStore((state) => state.resolvedTheme);
  const selectedNodeId = useStore(
    workflowStore,
    (state) => state.selectedNodeId,
  );
  const canUndo = useStore(
    workflowStore.temporal,
    (state) => state.pastStates.length > 0,
  );
  const canRedo = useStore(
    workflowStore.temporal,
    (state) => state.futureStates.length > 0,
  );
  const onNodesChange = useStore(workflowStore, (state) => state.onNodesChange);
  const onEdgesChange = useStore(workflowStore, (state) => state.onEdgesChange);
  const addNode = useStore(workflowStore, (state) => state.addNode);
  const addConnection = useStore(workflowStore, (state) => state.addConnection);
  const setNodes = useStore(workflowStore, (state) => state.setNodes);
  const setSelectedNodeId = useStore(
    workflowStore,
    (state) => state.setSelectedNodeId,
  );
  const startNodeDrag = useStore(workflowStore, (state) => state.startNodeDrag);
  const finishNodeDrag = useStore(
    workflowStore,
    (state) => state.finishNodeDrag,
  );
  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);

  const displayEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        interactionWidth: edge.interactionWidth ?? 24,
        style: {
          stroke: 'var(--muted-foreground)',
          strokeWidth: 1,
          ...edge.style,
          ...(edge.selected
            ? { stroke: 'var(--primary)', strokeWidth: 2 }
            : {}),
          ...(edge.source === selectedNodeId || edge.target === selectedNodeId
            ? { strokeDasharray: '5 5' }
            : {}),
        },
      })),
    [edges, selectedNodeId],
  );

  const addPaletteNode = (type: WorkflowNodeType, x: number, y: number) => {
    if (!reactFlowInstance) return;
    const id = crypto.randomUUID();
    const position = reactFlowInstance.screenToFlowPosition({ x, y });
    const group =
      type === 'group' ? undefined : findGroupAtPosition(nodes, position);
    addNode({
      id,
      type,
      position: group
        ? { x: position.x - group.position.x, y: position.y - group.position.y }
        : position,
      data: createNodeData(type, t),
      ...(type === 'group'
        ? {
            zIndex: -1001,
            style: { width: 480, height: 320, backgroundColor: 'transparent' },
          }
        : {}),
      ...(group ? { parentId: group.id } : {}),
    });
  };

  const onNodeDragStop = (_: unknown, draggedNode: Node) => {
    if (draggedNode.type === 'group') {
      finishNodeDrag();
      return;
    }
    const absolutePosition = getAbsolutePosition(draggedNode, nodes);
    const group = findGroupAtPosition(nodes, absolutePosition, draggedNode.id);
    if (group?.id !== draggedNode.parentId) {
      setNodes(
        sortNodesParentFirst(
          nodes.map((node) =>
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
          ),
        ),
      );
    }
    finishNodeDrag();
  };

  return (
    <>
      {!readOnly ? <WorkflowSidebar onNodeDrop={addPaletteNode} /> : null}
      <SidebarInset>
        {header}
        <div className='flex min-h-0 flex-1'>
          {canvasContent ?? (
            <ReactFlow
              colorMode={colorMode}
              fitView
              nodes={nodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              onInit={setReactFlowInstance}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              onConnect={readOnly ? undefined : addConnection}
              onNodeDragStart={readOnly ? undefined : startNodeDrag}
              onNodeDragStop={readOnly ? undefined : onNodeDragStop}
              onNodesChange={readOnly ? undefined : onNodesChange}
              onEdgesChange={readOnly ? undefined : onEdgesChange}
              onSelectionChange={({ nodes: selectedNodes }) =>
                setSelectedNodeId(selectedNodes.at(-1)?.id ?? null)
              }
            >
              <MiniMap />
              <Controls />
              <Background className='bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_95%_93%/0.5),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_95%_94%/0.24),transparent)] dark:bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_70%_20%/0.32),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_70%_18%/0.18),transparent)]' />
              <Panel position='top-left'>
                <div className='bg-background z-10 flex gap-1 rounded-md border p-1 shadow-sm'>
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    aria-label={t('workflowEditor.undo')}
                    title={t('workflowEditor.undoShortcut')}
                    disabled={readOnly || !canUndo}
                    onClick={() => {
                      const { undo, pastStates } =
                        workflowStore.temporal.getState();
                      if (pastStates.length > 0) undo();
                    }}
                  >
                    <Undo2Icon />
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    aria-label={t('workflowEditor.redo')}
                    title={t('workflowEditor.redoShortcut')}
                    disabled={readOnly || !canRedo}
                    onClick={() => {
                      const { redo, futureStates } =
                        workflowStore.temporal.getState();
                      if (futureStates.length > 0) redo();
                    }}
                  >
                    <Redo2Icon />
                  </Button>
                </div>
              </Panel>
              <Panel position='top-right'>
                <Button
                  variant='secondary'
                  disabled={readOnly || isRunning}
                  onClick={onRun}
                >
                  {isRunning ? (
                    <Spinner data-icon='inline-start' />
                  ) : (
                    <Play data-icon='inline-start' />
                  )}
                  {isRunning
                    ? runningNodeId
                      ? t('workflowEditor.runningNode', { id: runningNodeId })
                      : t('workflowEditor.running')
                    : t('workflows.run')}
                </Button>
              </Panel>
            </ReactFlow>
          )}
        </div>
        {children}
      </SidebarInset>
    </>
  );
}

export { WorkflowCanvas };
