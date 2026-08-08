import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Globe2Icon } from 'lucide-react';

function RemoteAgentNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowRemoteAgentNodeData>>) {
  return (
    <div
      className={cn(
        'w-64 rounded-md border-2 border-sky-500/50 bg-sky-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-sky-500 shadow-sm shadow-sky-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-sky-500!'
      />
      <div className='flex items-center gap-2'>
        <Globe2Icon
          className='size-5 shrink-0 text-sky-500'
          aria-hidden='true'
        />
        <p className='truncate font-medium text-sky-700 dark:text-sky-300'>
          {data.name}
        </p>
      </div>
      <p className='text-muted-foreground mt-2 line-clamp-2 text-sm'>
        {data.description}
      </p>
      <p className='text-muted-foreground mt-3 truncate border-t border-sky-500/20 pt-2 text-xs'>
        {data.url}
      </p>
      <Handle
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-sky-500!'
      />
    </div>
  );
}

export { RemoteAgentNode };
