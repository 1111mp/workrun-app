import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CircleStopIcon } from 'lucide-react';

function EndNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowEndNodeData>>) {
  const label = data.label || 'End';

  return (
    <div
      className={cn(
        'bg-rose-500/10 min-w-32 rounded-md border-2 border-rose-500/50 px-3 py-2.5 transition-[border-color,box-shadow]',
        selected && 'border-rose-500 shadow-sm shadow-rose-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-rose-500!'
      />
      <div className='flex items-center gap-2'>
        <CircleStopIcon className='size-5 text-rose-500' aria-hidden='true' />
        <Label className='text-rose-700 dark:text-rose-300'>{label}</Label>
      </div>
    </div>
  );
}

export { EndNode };
