import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@workspace/ui/components';
import {
  ChevronDownIcon,
  CircleAlertIcon,
  ClipboardIcon,
  Globe2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ArtifactFiles } from '@/components/artifact-files';
import { listRemoteTasks } from '@/services/remote-agent';

export function RemoteTasksPanel({
  runId,
  isActive,
  nodeName,
}: {
  runId?: string;
  isActive: boolean;
  nodeName: (id: string) => string;
}) {
  const { t } = useTranslation();
  const tasks = useQuery({
    queryKey: ['remoteTasks', runId, isActive],
    queryFn: () => listRemoteTasks(runId!),
    enabled: Boolean(runId),
  });
  async function copyMessageId(messageId: string) {
    try {
      await navigator.clipboard.writeText(messageId);
      toast.success(t('workflowEditor.remoteTasks.messageIdCopied'), {
        toasterId: 'global',
      });
    } catch {
      toast.error(t('workflowEditor.remoteTasks.messageIdCopyFailed'), {
        toasterId: 'global',
      });
    }
  }
  if (!runId || (!tasks.isError && !tasks.data?.length)) return null;
  return (
    <>
      <Collapsible defaultOpen={!isActive} className='flex flex-col gap-3'>
        <CollapsibleTrigger
          render={<Button variant='outline' className='justify-between' />}
        >
          <Globe2Icon data-icon='inline-start' />
          {t('workflowEditor.remoteTasks.title')}
          <ChevronDownIcon data-icon='inline-end' />
        </CollapsibleTrigger>
        <CollapsibleContent className='flex flex-col gap-3'>
          <p className='text-muted-foreground text-sm'>
            {t('workflowEditor.remoteTasks.description')}
          </p>
          {tasks.isError && (
            <Alert variant='destructive'>
              <CircleAlertIcon />
              <AlertTitle>
                {t('workflowEditor.remoteTasks.loadFailed')}
              </AlertTitle>
              <AlertDescription>{String(tasks.error)}</AlertDescription>
            </Alert>
          )}
          {tasks.data?.map((task) => (
            <section
              key={task.id}
              className='flex flex-col gap-3 rounded-md border p-3'
            >
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <span className='font-medium'>{nodeName(task.nodeId)}</span>
                <Badge
                  variant={task.status === 'unknown' ? 'outline' : 'secondary'}
                >
                  {t(`workflowEditor.remoteTasks.status.${task.status}`, {
                    defaultValue: task.status,
                  })}
                </Badge>
              </div>
              <p className='text-muted-foreground text-xs break-all'>
                {task.serviceOrigin}
              </p>
              <p className='font-mono text-xs break-all'>
                {task.taskId ?? t('workflowEditor.remoteTasks.noTaskId')}
              </p>
              {task.status === 'unknown' && !task.taskId && task.messageId && (
                <div className='flex flex-wrap items-center gap-2'>
                  <div className='min-w-0 flex-1'>
                    <p className='text-muted-foreground text-xs'>
                      {t('workflowEditor.remoteTasks.messageId')}
                    </p>
                    <p className='font-mono text-xs break-all'>
                      {task.messageId}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => void copyMessageId(task.messageId)}
                  >
                    <ClipboardIcon data-icon='inline-start' />
                    {t('workflowEditor.remoteTasks.copyMessageId')}
                  </Button>
                </div>
              )}
              {task.status === 'unknown' && (
                <Alert>
                  <CircleAlertIcon />
                  <AlertTitle>
                    {t('workflowEditor.remoteTasks.unknownTitle')}
                  </AlertTitle>
                  <AlertDescription>
                    {task.taskId
                      ? t('workflowEditor.remoteTasks.unknownDescription')
                      : t('workflowEditor.remoteTasks.unknownSubmission')}
                  </AlertDescription>
                </Alert>
              )}
              {task.lastKnownState && (
                <p className='text-muted-foreground text-xs'>
                  {t('workflowEditor.remoteTasks.lastKnown', {
                    state: t(
                      `workflowEditor.remoteTasks.status.${task.lastKnownState.replace('TASK_STATE_', '').toLowerCase()}`,
                    ),
                  })}
                </p>
              )}
              {task.lastCheckedAt && (
                <p className='text-muted-foreground text-xs'>
                  {t('workflowEditor.remoteTasks.lastChecked', {
                    time: new Date(task.lastCheckedAt).toLocaleString(),
                  })}
                </p>
              )}
              {task.result && (
                <>
                  <p className='max-h-48 overflow-auto text-sm whitespace-pre-wrap'>
                    {task.result.response}
                  </p>
                  <ArtifactFiles value={task.result.artifacts} />
                </>
              )}
            </section>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
