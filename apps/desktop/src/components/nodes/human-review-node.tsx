import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { UserRoundIcon } from 'lucide-react';

function HumanReviewNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowHumanReviewNodeData>>) {
  return (
    <div
      className={cn(
        'relative w-64 rounded-md border-2 border-yellow-400/70 bg-yellow-400/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-yellow-400 shadow-sm shadow-yellow-400/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-yellow-400!'
      />
      <div className='flex items-center gap-2.5'>
        <span className='flex size-8 shrink-0 items-center justify-center rounded-full bg-yellow-400/20 text-yellow-700 dark:text-yellow-200'>
          <UserRoundIcon className='size-4' aria-hidden='true' />
        </span>
        <div className='min-w-0'>
          <p className='text-[10px] font-semibold tracking-[0.14em] text-yellow-700/80 uppercase dark:text-yellow-200/80'>
            Human checkpoint
          </p>
          <p className='truncate font-medium text-yellow-800 dark:text-yellow-100'>
            {data.title || 'Human review'}
          </p>
        </div>
      </div>
      <p className='text-muted-foreground mt-2 line-clamp-2 text-sm'>
        {data.description || 'Pause for human approval.'}
      </p>
      <div className='mt-3 space-y-2 border-t border-yellow-400/30 pt-2 text-xs font-medium'>
        <div className='relative min-h-5 pr-5 text-emerald-600 dark:text-emerald-400'>
          Approved
          <Handle
            id='approved'
            type='source'
            position={Position.Right}
            isConnectable={isConnectable}
            style={{ top: '50%' }}
            className='bg-background! size-3! border-2! border-emerald-500!'
          />
        </div>
        <div className='relative min-h-5 pr-5 text-rose-600 dark:text-rose-400'>
          Rejected
          <Handle
            id='rejected'
            type='source'
            position={Position.Right}
            isConnectable={isConnectable}
            style={{ top: '50%' }}
            className='bg-background! size-3! border-2! border-rose-500!'
          />
        </div>
      </div>
    </div>
  );
}

export { HumanReviewNode };
