import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { SplitIcon } from 'lucide-react';

const fallbackCases: WorkflowSwitchCase[] = [
  { id: 'case-1', value: 'case_1', label: 'Case 1' },
  { id: 'case-2', value: 'case_2', label: 'Case 2' },
];

function SwitchNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowSwitchNodeData>>) {
  const label = data.label || 'Switch';
  const field = data.selector?.field || 'Configure route state field';
  const cases = data.cases?.length ? data.cases : fallbackCases;
  const defaultLabel = data.defaultLabel || 'Default';
  const defaultHandleTop = 89 + cases.length * 26;

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
      <p className='bg-background/50 text-muted-foreground mt-2 truncate rounded px-2 py-1.5 font-mono text-xs'>
        state.{field}
      </p>
      <div className='mt-3 space-y-2 border-t border-cyan-500/20 pt-2 text-xs font-medium'>
        {cases.map((switchCase) => (
          <div
            key={switchCase.id}
            className='flex items-center justify-between text-cyan-700 dark:text-cyan-300'
          >
            <span className='truncate'>
              {switchCase.label} ({switchCase.value})
            </span>
            <span>→</span>
          </div>
        ))}
        <div className='text-muted-foreground flex items-center justify-between'>
          <span>{defaultLabel}</span>
          <span>→</span>
        </div>
      </div>
      {cases.map((switchCase, index) => (
        <Handle
          key={switchCase.id}
          id={`case:${switchCase.id}`}
          type='source'
          position={Position.Right}
          isConnectable={isConnectable}
          style={{ top: 89 + index * 26 }}
          className='bg-background! size-3! border-2! border-cyan-500!'
        />
      ))}
      <Handle
        id='default'
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        style={{ top: defaultHandleTop }}
        className='bg-background! border-muted-foreground! size-3! border-2!'
      />
    </div>
  );
}

export { SwitchNode };
