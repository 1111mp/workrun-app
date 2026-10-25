import { Badge } from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import {
  NodeToolbar,
  Position,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import { createContext, useContext } from 'react';

import { workflowNodeTypes } from '@/components/nodes/node-types';

import type { WorkflowChange } from './diff';

export type NodeDiffDecoration = {
  status: WorkflowChange['status'];
  label: string;
  fields: string;
};
export const NodeDiffContext = createContext<
  ReadonlyMap<string, NodeDiffDecoration>
>(new Map());
const badgeClass = {
  added: 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
  modified: 'border-amber-500/50 text-amber-700 dark:text-amber-300',
  removed: 'border-destructive text-destructive border-dashed',
};
const symbols = { added: '+', modified: '~', removed: '−' };

function decorateNode(Component: NodeTypes[string]) {
  return function WorkflowDiffNode(props: NodeProps) {
    const decoration = useContext(NodeDiffContext).get(props.id);
    return (
      <div
        className={cn(
          'relative rounded-lg',
          props.type === 'group' && 'size-full',
          decoration?.status === 'removed' &&
            'outline outline-offset-3 outline-dashed outline-destructive',
          props.selected &&
            'outline-3 outline-offset-3 outline-solid outline-primary',
        )}
      >
        {/* Selection is drawn outside the original node so its type colors stay
          intact. Disabling the renderer's selected state also hides group resizing. */}
        <Component {...props} selected={false} isConnectable={false} />
        {decoration && (
          <NodeToolbar
            nodeId={props.id}
            position={Position.Top}
            isVisible
            offset={12}
          >
            <Badge
              variant='outline'
              className={cn(
                'bg-(--workrun-panel-hover) shadow-sm',
                badgeClass[decoration.status],
              )}
            >
              <span aria-hidden>{symbols[decoration.status]}</span>
              {decoration.label}
              {decoration.fields ? ` · ${decoration.fields}` : ''}
            </Badge>
          </NodeToolbar>
        )}
      </div>
    );
  };
}
export const workflowDiffNodeTypes: NodeTypes = Object.fromEntries(
  Object.entries(workflowNodeTypes).map(([type, Component]) => [
    type,
    decorateNode(Component),
  ]),
);
