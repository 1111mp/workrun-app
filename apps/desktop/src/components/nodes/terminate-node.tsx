import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { OctagonXIcon } from 'lucide-react';

function TerminateNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowTerminateNodeData>>) {
  return (
    <div
      className={cn(
        'bg-destructive/10 min-w-40 rounded-md border-2 border-destructive/50 px-3 py-2.5 transition-[border-color,box-shadow]',
        selected && 'border-destructive shadow-sm shadow-destructive/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! border-destructive! size-3! border-2!'
      />
      <div className='flex items-center gap-2'>
        <OctagonXIcon className='text-destructive size-5' aria-hidden='true' />
        <Label className='text-destructive'>
          {data.label || 'Terminate workflow'}
        </Label>
      </div>
    </div>
  );
}

export { TerminateNode };
