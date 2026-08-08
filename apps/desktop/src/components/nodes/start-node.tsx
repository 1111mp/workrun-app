import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CirclePlayIcon } from 'lucide-react';

function StartNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowStartNodeData>>) {
  const label = data.label || 'Start';

  return (
    <div
      className={cn(
        'bg-emerald-500/10 min-w-32 rounded-md border-2 border-emerald-500/50 px-3 py-2.5 transition-[border-color,box-shadow]',
        selected && 'border-emerald-500 shadow-sm shadow-emerald-500/30',
      )}
    >
      <div className='flex items-center gap-2'>
        <CirclePlayIcon
          className='size-5 text-emerald-500'
          aria-hidden='true'
        />
        <Label className='text-emerald-700 dark:text-emerald-300'>
          {label}
        </Label>
      </div>
      <Handle
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-emerald-500!'
      />
    </div>
  );
}

export { StartNode };
