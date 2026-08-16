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
import { Play, Redo2Icon, Undo2Icon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';

import {
  AgentNode,
  EndNode,
  GroupNode,
  IfElseNode,
  ProcessNode,
  RemoteAgentNode,
  StartNode,
  SwitchNode,
} from '@/components/nodes';
import { WorkflowSidebar } from '@/components/workflow-sidebar';
import { useWorkflowStore, useWorkrunStore } from '@/stores';

const nodeTypes = {
  agent: AgentNode,
  remote_agent: RemoteAgentNode,
  process: ProcessNode,
  start: StartNode,
  end: EndNode,
  if_else: IfElseNode,
  switch: SwitchNode,
  group: GroupNode,
};

function createNodeData(type: WorkflowNodeType) {
  switch (type) {
    case 'agent':
      return {
        name: 'New agent',
        modelProfileId: '',
        description: 'Describe this agent’s responsibility',
        instruction: '',
        temperature: undefined,
        topP: undefined,
        toolIds: [],
        maxToolCalls: 8,
        toolTimeoutSeconds: 60,
      };
    case 'remote_agent':
      return {
        name: 'New remote agent',
        url: 'https://',
        description: 'Describe this remote agent',
      };
    case 'process':
      return {
        name: 'New app',
        processNodeId: '',
        description: 'Select an app to run in this workflow',
      };
    case 'if_else':
      return {
        label: 'If / Else',
        conditions: {
          true: { label: 'True', condition: '' },
          false: { label: 'False', condition: '' },
        },
      };
    case 'switch':
      return {
        label: 'Switch',
        cases: [
          { id: 'case-1', label: 'Case 1', condition: '' },
          { id: 'case-2', label: 'Case 2', condition: '' },
        ],
        defaultCase: { label: 'Default', condition: '' },
      };
    case 'start':
      return { label: 'Start' };
    case 'end':
      return { label: 'End' };
    case 'group':
      return { label: 'New group' };
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
  children: ReactNode;
  header: ReactNode;
  isRunning: boolean;
  runningNodeId: string | null;
  onRun: () => void;
};

function WorkflowCanvas({
  children,
  header,
  isRunning,
  runningNodeId,
  onRun,
}: WorkflowCanvasProps) {
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const colorMode = useWorkrunStore((state) => state.resolvedTheme);
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId);
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
  const setNodes = useWorkflowStore((state) => state.setNodes);
  const setSelectedNodeId = useWorkflowStore(
    (state) => state.setSelectedNodeId,
  );
  const startNodeDrag = useWorkflowStore((state) => state.startNodeDrag);
  const finishNodeDrag = useWorkflowStore((state) => state.finishNodeDrag);
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
    const position = reactFlowInstance.screenToFlowPosition({ x, y });
    const group =
      type === 'group' ? undefined : findGroupAtPosition(nodes, position);
    addNode({
      id: crypto.randomUUID(),
      type,
      position: group
        ? { x: position.x - group.position.x, y: position.y - group.position.y }
        : position,
      data: createNodeData(type),
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
      <WorkflowSidebar onNodeDrop={addPaletteNode} />
      <SidebarInset>
        {header}
        <div className='flex flex-1'>
          <ReactFlow
            colorMode={colorMode}
            fitView
            nodes={nodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onInit={setReactFlowInstance}
            onConnect={addConnection}
            onNodeDragStart={startNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
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
              <Button variant='secondary' disabled={isRunning} onClick={onRun}>
                {isRunning ? (
                  <Spinner data-icon='inline-start' />
                ) : (
                  <Play data-icon='inline-start' />
                )}
                {isRunning
                  ? runningNodeId
                    ? `Running ${runningNodeId}…`
                    : 'Running…'
                  : 'Run'}
              </Button>
            </Panel>
          </ReactFlow>
        </div>
        {children}
      </SidebarInset>
    </>
  );
}

export { WorkflowCanvas };
