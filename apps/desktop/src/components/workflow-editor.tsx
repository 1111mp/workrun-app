import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Separator,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
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
import { Redo2Icon, Undo2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { WorkflowSidebar } from '@/components/workflow-sidebar';
import { useWorkflowStore, useWorkrunStore } from '@/stores';

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
  const config = useWorkrunStore((state) => state.config);

  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
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
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const setNodes = useWorkflowStore((state) => state.setNodes);
  const setSelectedNodeId = useWorkflowStore(
    (state) => state.setSelectedNodeId,
  );
  const clearSelection = useWorkflowStore((state) => state.clearSelection);
  const startNodeDrag = useWorkflowStore((state) => state.startNodeDrag);
  const finishNodeDrag = useWorkflowStore((state) => state.finishNodeDrag);

  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  console.log('nodes', nodes);
  console.log('edges', edges);

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

  return (
    <SidebarProvider className='flex size-full grow flex-row'>
      <WorkflowSidebar onNodeDrop={addPaletteNode} />
      <SidebarInset>
        <header className='flex h-12 shrink-0 items-center gap-2'>
          <div className='flex items-center gap-2 px-4'>
            <SidebarTrigger className='-ml-1' />
            <Separator
              orientation='vertical'
              className='my-auto mr-2 data-[orientation=vertical]:h-4'
            />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className='hidden md:block'>
                  <BreadcrumbLink href='#'>
                    Build Your Application
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className='hidden md:block' />
                <BreadcrumbItem>
                  <BreadcrumbPage>Data Fetching</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
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
          </ReactFlow>
        </div>
        <WorkflowNodeInspector
          node={selectedNode}
          modelProfiles={config?.model_profiles}
          onClose={closeInspector}
          onDataChange={onNodeDataChange}
        />
      </SidebarInset>
    </SidebarProvider>
  );
}

export { WorkflowEditor };
