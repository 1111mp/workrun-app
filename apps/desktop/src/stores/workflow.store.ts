import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { temporal } from 'zundo';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

const maxHistoryEntries = 50;

type TrackedWorkflowState = {
  nodes: Node[];
  edges: Edge[];
};

type WorkflowDocumentState = TrackedWorkflowState & {
  settings: WorkflowSettings;
};

type WorkflowStore = TrackedWorkflowState & {
  settings: WorkflowSettings;
  selectedNodeId: string | null;
  dragStartNodes: Node[] | null;
  onNodesChange: (changes: NodeChange<Node>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  addNode: (node: Node) => void;
  addConnection: (connection: Connection | Edge) => void;
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  updateSettings: (patch: Partial<WorkflowSettings>) => void;
  replaceWorkflow: (workflow: WorkflowDocumentState) => void;
  setNodes: (nodes: Node[]) => void;
  setSelectedNodeId: (nodeId: string | null) => void;
  clearSelection: () => void;
  startNodeDrag: () => void;
  finishNodeDrag: () => void;
};

const initialNodes: Node[] = [
  {
    id: 'start-node-default',
    type: 'start',
    position: { x: 100, y: 200 },
    data: { label: 'Start' },
  },
];

const initialSettings: WorkflowSettings = {
  name: 'Untitled workflow',
  description: '',
  mode: 'task',
  inputSchema: { fields: [] },
};

export const useWorkflowStore = create<WorkflowStore>()(
  temporal(
    immer((set, get) => ({
      nodes: initialNodes,
      edges: [],
      settings: initialSettings,
      selectedNodeId: null,
      dragStartNodes: null,

      onNodesChange: (changes) => {
        const removedNodeIds = new Set(
          changes.flatMap((change) =>
            change.type === 'remove' ? [change.id] : [],
          ),
        );
        set((state) => {
          state.nodes = applyNodeChanges(changes, state.nodes);
          // React Flow emits the connected-edge removals separately. Removing
          // them here keeps a node deletion as one zundo history entry.
          if (removedNodeIds.size > 0) {
            state.edges = state.edges.filter(
              (edge) =>
                !removedNodeIds.has(edge.source) &&
                !removedNodeIds.has(edge.target),
            );
          }
        });
      },

      onEdgesChange: (changes) => {
        set((state) => {
          state.edges = applyEdgeChanges(changes, state.edges);
        });
      },

      addNode: (node) => {
        set((state) => {
          state.nodes.push(node);
        });
      },

      addConnection: (connection) => {
        const source = get().nodes.find(
          (node) => node.id === connection.source,
        );
        if (!source) {
          return;
        }

        const isBranch = source.type === 'if_else' || source.type === 'switch';
        if (isBranch && !connection.sourceHandle) {
          return;
        }
        if (
          source.type === 'if_else' &&
          connection.sourceHandle !== 'true' &&
          connection.sourceHandle !== 'false'
        ) {
          return;
        }
        if (
          source.type === 'switch' &&
          connection.sourceHandle !== 'default' &&
          !connection.sourceHandle?.startsWith('case:')
        ) {
          return;
        }

        const existing = get().edges.some((edge) =>
          isBranch
            ? edge.source === connection.source &&
              edge.sourceHandle === connection.sourceHandle
            : edge.source === connection.source &&
              edge.target === connection.target &&
              edge.sourceHandle === connection.sourceHandle &&
              edge.targetHandle === connection.targetHandle,
        );
        if (!existing) {
          set((state) => {
            state.edges = addEdge(connection, state.edges);
          });
        }
      },

      updateNodeData: (nodeId, patch) => {
        set((state) => {
          const currentNode = state.nodes.find(
            (candidate) => candidate.id === nodeId,
          );
          if (!currentNode) {
            return;
          }

          if ('cases' in patch) {
            const getCaseIds = (value: unknown) =>
              new Set(
                Array.isArray(value)
                  ? value.flatMap((item) =>
                      typeof item === 'object' &&
                      item !== null &&
                      typeof item.id === 'string'
                        ? [item.id]
                        : [],
                    )
                  : [],
              );
            const removedHandles = new Set(
              [...getCaseIds(currentNode.data.cases)]
                .filter((caseId) => !getCaseIds(patch.cases).has(caseId))
                .map((caseId) => `case:${caseId}`),
            );
            state.edges = state.edges.filter(
              (edge) =>
                edge.source !== nodeId ||
                !removedHandles.has(edge.sourceHandle ?? ''),
            );
          }
          currentNode.data = { ...currentNode.data, ...patch };
        });
      },

      updateSettings: (patch) => {
        set((state) => {
          state.settings = { ...state.settings, ...patch };
        });
      },

      replaceWorkflow: (workflow) => {
        set({
          nodes: workflow.nodes,
          edges: workflow.edges,
          settings: workflow.settings,
          selectedNodeId: null,
        });
      },

      setNodes: (nodes) => set({ nodes }),
      setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
      clearSelection: () => {
        set((state) => {
          state.selectedNodeId = null;
          state.nodes.forEach((node) => {
            node.selected = false;
          });
        });
      },

      startNodeDrag: () => {
        set({ dragStartNodes: get().nodes });
        useWorkflowStore.temporal.getState().pause();
      },

      finishNodeDrag: () => {
        const dragStartNodes = get().dragStartNodes;
        if (!dragStartNodes) {
          useWorkflowStore.temporal.getState().resume();
          return;
        }

        const finalNodes = get().nodes;
        // While tracking is paused, return to the pre-drag nodes. Resuming and
        // restoring the final nodes creates one temporal entry for the drag.
        set({ nodes: dragStartNodes, dragStartNodes: null });
        useWorkflowStore.temporal.getState().resume();
        set({ nodes: finalNodes });
      },
    })),
    {
      // Only track nodes and edges for undo/redo
      // Exclude selected, width, height, measured (dimension changes from React Flow rendering)
      partialize: (state): TrackedWorkflowState => ({
        nodes: state.nodes.map(
          ({ selected: _selected, width: _width, height: _height, ...node }) =>
            node as Node,
        ),
        edges: state.edges.map(
          ({ selected: _selected, ...edge }) => edge as Edge,
        ),
      }),
      // Prevent duplicate history entries for identical states
      equality: (pastState, currentState) =>
        JSON.stringify(pastState) === JSON.stringify(currentState),
      // Limit history stack size
      limit: maxHistoryEntries,
    },
  ),
);
