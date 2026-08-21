import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CircleHelpIcon } from 'lucide-react';

const fallbackOptions: WorkflowAskUserQuestionOption[] = [
  { id: 'option-1', label: 'Option 1' },
  { id: 'option-2', label: 'Option 2' },
];

function AskUserQuestionNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowAskUserQuestionNodeData>>) {
  const options = data.options?.length ? data.options : fallbackOptions;

  return (
    <div
      className={cn(
        'relative w-64 rounded-md border-2 border-blue-500/50 bg-blue-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-blue-500 shadow-sm shadow-blue-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-blue-500!'
      />
      <div className='flex items-center gap-2'>
        <CircleHelpIcon
          className='size-5 shrink-0 text-blue-500'
          aria-hidden='true'
        />
        <p className='truncate font-medium text-blue-700 dark:text-blue-300'>
          {data.title || 'Ask user question'}
        </p>
      </div>
      {data.description ? (
        <p className='text-muted-foreground mt-2 line-clamp-2 text-sm'>
          {data.description}
        </p>
      ) : null}
      <div className='mt-3 space-y-2 border-t border-blue-500/20 pt-2 text-xs font-medium'>
        {options.map((option) => (
          <div
            key={option.id}
            className='relative min-h-5 pr-5 text-blue-700 dark:text-blue-300'
          >
            <p className='truncate'>{option.label || 'Untitled option'}</p>
          </div>
        ))}
      </div>
      {options.map((option, index) => (
        <Handle
          key={option.id}
          id={`option:${option.id}`}
          type='source'
          position={Position.Right}
          isConnectable={isConnectable}
          style={{ top: 76 + index * 28 }}
          className='bg-background! size-3! border-2! border-blue-500!'
        />
      ))}
    </div>
  );
}

export { AskUserQuestionNode };
