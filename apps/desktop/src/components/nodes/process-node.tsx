import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { TerminalIcon } from 'lucide-react';

function ProcessNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowProcessNodeData>>) {
  return (
    <div
      className={cn(
        'w-64 rounded-md border-2 border-lime-500/50 bg-lime-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-lime-500 shadow-sm shadow-lime-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-lime-500!'
      />
      <div className='flex items-center gap-2'>
        <TerminalIcon
          className='size-5 shrink-0 text-lime-500'
          aria-hidden='true'
        />
        <p className='truncate font-medium text-lime-700 dark:text-lime-300'>
          {data.name}
        </p>
      </div>
      <p className='text-muted-foreground mt-2 line-clamp-2 text-sm'>
        {data.description}
      </p>
      <p className='text-muted-foreground mt-3 truncate border-t border-lime-500/20 pt-2 text-xs'>
        {data.processNodeId ? 'App selected' : 'Select an app'}
      </p>
      <Handle
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-lime-500!'
      />
    </div>
  );
}

export { ProcessNode };
