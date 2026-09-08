import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { GitBranchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function IfElseNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowIfElseNodeData>>) {
  const { t } = useTranslation();
  const label = data.label || t('workflowEditor.nodes.ifElse');
  const trueBranch = data.conditions?.true;
  const falseBranch = data.conditions?.false;

  return (
    <div
      className={cn(
        'relative w-64 rounded-md border-2 border-amber-500/50 bg-amber-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-amber-500 shadow-sm shadow-amber-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-amber-500!'
      />
      <div className='flex items-center gap-2'>
        <GitBranchIcon
          className='size-5 shrink-0 text-amber-500'
          aria-hidden='true'
        />
        <p className='truncate font-medium text-amber-700 dark:text-amber-300'>
          {label}
        </p>
      </div>
      <div className='mt-3 space-y-2 border-t border-amber-500/20 pt-2 text-xs font-medium'>
        <div className='relative min-h-11 pr-5 text-emerald-600 dark:text-emerald-400'>
          <p className='truncate'>
            {trueBranch?.label || t('workflowEditor.nodes.true')}
          </p>
          <p
            className={cn(
              'mt-0.5 truncate font-mono text-[11px]',
              trueBranch?.condition
                ? 'text-muted-foreground'
                : 'text-muted-foreground/60',
            )}
          >
            {trueBranch?.condition ||
              t('workflowEditor.nodes.whenConditionTrue')}
          </p>
          <Handle
            id='true'
            type='source'
            position={Position.Right}
            isConnectable={isConnectable}
            style={{ top: '50%' }}
            className='bg-background! size-3! border-2! border-emerald-500!'
          />
        </div>
        <div className='relative min-h-11 pr-5 text-rose-600 dark:text-rose-400'>
          <p className='truncate'>
            {falseBranch?.label || t('workflowEditor.nodes.false')}
          </p>
          <p
            className={cn(
              'mt-0.5 truncate font-mono text-[11px]',
              falseBranch?.condition
                ? 'text-muted-foreground'
                : 'text-muted-foreground/60',
            )}
          >
            {falseBranch?.condition ||
              t('workflowEditor.nodes.whenConditionFalse')}
          </p>
          <Handle
            id='false'
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

export { IfElseNode };
