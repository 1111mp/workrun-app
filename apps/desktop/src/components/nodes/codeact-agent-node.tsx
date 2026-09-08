import { useQuery } from '@tanstack/react-query';
import { cn } from '@workspace/ui/lib/utils';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CodeXmlIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getModelCatalog } from '@/services/cmd';

function CodeActAgentNode({
  data,
  isConnectable,
  selected,
}: NodeProps<Node<WorkflowCodeActAgentNodeData>>) {
  const { t } = useTranslation();
  const { data: modelProfiles = [] } = useQuery({
    queryKey: ['modelCatalog'],
    queryFn: getModelCatalog,
  });
  const modelProfile = modelProfiles.find(
    (profile) => profile.id === data.modelProfileId,
  );
  return (
    <div
      className={cn(
        'w-64 rounded-md border-2 border-fuchsia-500/50 bg-fuchsia-500/10 p-3 transition-[border-color,box-shadow]',
        selected && 'border-fuchsia-500 shadow-sm shadow-fuchsia-500/30',
      )}
    >
      <Handle
        type='target'
        position={Position.Left}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-fuchsia-500!'
      />
      <div className='flex items-center gap-2'>
        <CodeXmlIcon
          className='size-5 shrink-0 text-fuchsia-500'
          aria-hidden='true'
        />
        <p className='truncate font-medium text-fuchsia-700 dark:text-fuchsia-300'>
          {data.name}
        </p>
      </div>
      <p className='text-muted-foreground mt-2 line-clamp-2 text-sm'>
        {data.description}
      </p>
      <div className='text-muted-foreground mt-3 border-t border-fuchsia-500/20 pt-2 text-xs'>
        {t('workflowEditor.nodes.modelProfile')}:{' '}
        <span className='text-foreground'>
          {data.modelProfileId
            ? modelProfile
              ? `${modelProfile.name} · ${modelProfile.model}`
              : t('workflowEditor.nodes.modelProfileSelected')
            : t('workflowEditor.nodes.notSelected')}
        </span>
      </div>
      <Handle
        type='source'
        position={Position.Right}
        isConnectable={isConnectable}
        className='bg-background! size-3! border-2! border-fuchsia-500!'
      />
    </div>
  );
}

export { CodeActAgentNode };
