import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { WorkflowIcon } from 'lucide-react';

function SubworkflowNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowSubworkflowNodeData>>) {
  const configured = Boolean(data.workflowId);
  return (
    <div
      className={cn(
        'w-64 rounded-md border-2 border-indigo-500/50 bg-indigo-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-indigo-500 shadow-sm shadow-indigo-500/30',
      )}
    >
      <Handle type='target' position={Position.Left} isConnectable={isConnectable} className='bg-background! size-3! border-2! border-indigo-500!' />
      <div className='flex items-center gap-2'>
        <WorkflowIcon className='size-5 shrink-0 text-indigo-500' aria-hidden='true' />
        <p className='truncate font-medium text-indigo-700 dark:text-indigo-300'>
          {data.workflowName || 'Subworkflow'}
        </p>
      </div>
      <p className='text-muted-foreground mt-2 line-clamp-2 text-sm'>
        {configured ? 'Runs a referenced workflow' : 'Select a workflow'}
      </p>
      <p className='text-muted-foreground mt-3 truncate border-t border-indigo-500/20 pt-2 text-xs'>
        Isolated workflow scope
      </p>
      <Handle type='source' position={Position.Right} isConnectable={isConnectable} className='bg-background! size-3! border-2! border-indigo-500!' />
    </div>
  );
}

export { SubworkflowNode };
