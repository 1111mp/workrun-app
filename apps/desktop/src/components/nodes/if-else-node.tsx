import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { GitBranchIcon } from 'lucide-react';

function IfElseNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowIfElseNodeData>>) {
  const label = data.label || 'If / Else';
  const field = data.selector?.field || 'Configure boolean state field';

  return (
    <div
      className={cn(
        'relative w-64 rounded-md border-2 border-amber-500/50 bg-amber-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-amber-500 shadow-sm shadow-amber-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-amber-500!'
      />
      <div className='flex items-center gap-2'>
        <GitBranchIcon
          className='size-5 shrink-0 text-amber-500'
          aria-hidden='true'
        />
        <p className='truncate font-medium text-amber-700 dark:text-amber-300'>
          {label}
        </p>
      </div>
      <p className='bg-background/50 text-muted-foreground mt-2 truncate rounded px-2 py-1.5 font-mono text-xs'>
        state.{field}
      </p>
      <div className='mt-3 space-y-2 border-t border-amber-500/20 pt-2 text-xs font-medium'>
        <div className='flex items-center justify-between text-emerald-600 dark:text-emerald-400'>
          <span>True</span>
          <span>→</span>
        </div>
        <div className='flex items-center justify-between text-rose-600 dark:text-rose-400'>
          <span>False</span>
          <span>→</span>
        </div>
      </div>
      <Handle
        id='true'
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        style={{ top: 89 }}
        className='bg-background! size-3! border-2! border-emerald-500!'
      />
      <Handle
        id='false'
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        style={{ top: 115 }}
        className='bg-background! size-3! border-2! border-rose-500!'
      />
    </div>
  );
}

export { IfElseNode };
