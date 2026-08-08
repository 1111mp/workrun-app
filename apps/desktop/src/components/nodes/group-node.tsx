import { cn } from '@workspace/ui/lib/utils';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { Layers3Icon } from 'lucide-react';

function GroupNode({ data, selected }: NodeProps<Node<WorkflowGroupNodeData>>) {
  const label = data.label || 'Group';

  return (
    <div
      className={cn(
        'size-full rounded-lg border-2 border-dashed border-sky-500/45 transition-colors',
        selected && 'border-sky-500',
      )}
    >
      <NodeResizer
        minWidth={280}
        minHeight={180}
        isVisible={selected}
        lineClassName='border-sky-500'
        handleClassName='size-2 border-sky-500 bg-background'
      />
      <div className='flex items-center gap-2 px-3 py-2 text-sky-700 dark:text-sky-300'>
        <Layers3Icon className='size-4 shrink-0' aria-hidden='true' />
        <p className='truncate text-sm font-medium'>{label}</p>
      </div>
    </div>
  );
}

export { GroupNode };
