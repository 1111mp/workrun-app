import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { SplitIcon } from 'lucide-react';

const fallbackCases: WorkflowSwitchCase[] = [
  { id: 'case-1', label: 'Case 1', condition: '' },
  { id: 'case-2', label: 'Case 2', condition: '' },
];

function SwitchNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowSwitchNodeData>>) {
  const label = data.label || 'Switch';
  const cases = data.cases?.length ? data.cases : fallbackCases;
  const defaultCase = data.defaultCase ?? { label: 'Default', condition: '' };

  return (
    <div
      className={cn(
        'relative w-64 rounded-md border-2 border-cyan-500/50 bg-cyan-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-cyan-500 shadow-sm shadow-cyan-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-cyan-500!'
      />
      <div className='flex items-center gap-2'>
        <SplitIcon
          className='size-5 shrink-0 text-cyan-500'
          aria-hidden='true'
        />
        <p className='truncate font-medium text-cyan-700 dark:text-cyan-300'>
          {label}
        </p>
      </div>
      <div className='mt-3 space-y-2 border-t border-cyan-500/20 pt-2 text-xs font-medium'>
        {cases.map((switchCase) => (
          <div
            key={switchCase.id}
            className='relative min-h-11 pr-5 text-cyan-700 dark:text-cyan-300'
          >
            <p className='truncate'>{switchCase.label || 'Untitled case'}</p>
            <p
              className={cn(
                'mt-0.5 truncate font-mono text-[11px]',
                switchCase.condition
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/60',
              )}
            >
              {switchCase.condition || 'When condition is met'}
            </p>
          </div>
        ))}
        <div className='text-muted-foreground relative min-h-11 pr-5'>
          <p className='truncate'>{defaultCase.label || 'Default'}</p>
          <p className='text-muted-foreground/60 mt-0.5 truncate font-mono text-[11px]'>
            {defaultCase.condition || 'Other cases'}
          </p>
        </div>
      </div>
      {cases.map((switchCase, index) => (
        <Handle
          key={switchCase.id}
          id={`case:${switchCase.id}`}
          type='source'
          position={Position.Right}
          isConnectable={isConnectable}
          style={{ top: 75 + index * 52 }}
          className='bg-background! size-3! border-2! border-cyan-500!'
        />
      ))}
      <Handle
        id='default'
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        style={{ top: 75 + cases.length * 52 }}
        className='bg-background! border-muted-foreground! size-3! border-2!'
      />
    </div>
  );
}

export { SwitchNode };
