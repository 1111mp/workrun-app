import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { BotIcon } from 'lucide-react';

function AgentNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowAgentNodeData>>) {
  return (
    <div
      className={cn(
        'w-64 rounded-md border-2 border-violet-500/50 bg-violet-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-violet-500 shadow-sm shadow-violet-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-violet-500!'
      />
      <div className='flex items-center gap-2'>
        <BotIcon
          className='size-5 shrink-0 text-violet-500'
          aria-hidden='true'
        />
        <p className='truncate font-medium text-violet-700 dark:text-violet-300'>
          {data.name}
        </p>
      </div>
      <p className='text-muted-foreground mt-2 line-clamp-2 text-sm'>
        {data.description}
      </p>
      <div className='text-muted-foreground mt-3 border-t border-violet-500/20 pt-2 text-xs'>
        Model: <span className='text-foreground'>{data.model}</span>
      </div>
      <Handle
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-violet-500!'
      />
    </div>
  );
}

export { AgentNode };
