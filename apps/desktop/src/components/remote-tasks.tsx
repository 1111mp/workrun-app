import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Spinner,
} from '@workspace/ui/components';
import {
  ChevronDownIcon,
  CircleAlertIcon,
  ClipboardIcon,
  Globe2Icon,
  RotateCcwIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ArtifactFiles } from '@/components/artifact-files';
import {
  listRemoteTasks,
  listRemoteTaskWarnings,
  manageRemoteTask,
  remoteTaskMayRepeat,
  type RemoteTask,
} from '@/services/remote-agent';
import { inspectRunRecord } from '@/services/run-history';
import { useRunWorkspaceStore } from '@/stores/run-workspace.store';

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
  const client = useQueryClient();
  const [busy, setBusy] = useState<string>();
  const [cancelCandidate, setCancelCandidate] = useState<RemoteTask>();
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
  async function operate(
    task: RemoteTask,
    operation: 'query' | 'fetch' | 'cancel',
  ) {
    setBusy(task.id);
    try {
      await manageRemoteTask(task.id, operation);
    } catch (error) {
      toast.error(t('workflowEditor.remoteTasks.operationFailed'), {
        toasterId: 'global',
        description: String(error),
      });
    } finally {
      await client.invalidateQueries({ queryKey: ['remoteTasks', runId] });
      await client.invalidateQueries({ queryKey: ['remoteTaskWarnings'] });
      setBusy(undefined);
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
              <div className='flex flex-wrap gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={isActive || Boolean(busy) || !task.taskId}
                  onClick={() => void operate(task, 'query')}
                >
                  {busy === task.id && <Spinner />}
                  {t('workflowEditor.remoteTasks.query')}
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    isActive ||
                    Boolean(busy) ||
                    !task.taskId ||
                    task.status !== 'completed' ||
                    Boolean(task.result)
                  }
                  onClick={() => void operate(task, 'fetch')}
                >
                  {t('workflowEditor.remoteTasks.fetch')}
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    isActive ||
                    Boolean(busy) ||
                    !task.taskId ||
                    [
                      'completed',
                      'failed',
                      'canceled',
                      'rejected',
                      'not_found',
                    ].includes(task.status)
                  }
                  onClick={() => setCancelCandidate(task)}
                >
                  {t('workflowEditor.remoteTasks.cancel')}
                </Button>
              </div>
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
      <AlertDialog
        open={Boolean(cancelCandidate)}
        onOpenChange={(open) => {
          if (!open) setCancelCandidate(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workflowEditor.remoteTasks.cancelTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workflowEditor.remoteTasks.cancelDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('apps.new.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (cancelCandidate) void operate(cancelCandidate, 'cancel');
                setCancelCandidate(undefined);
              }}
            >
              {t('workflowEditor.remoteTasks.cancel')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function RemoteTaskRerunButton({
  runId,
  disabled,
  onRunAgain,
  label,
  localFailed = false,
}: {
  runId?: string;
  disabled: boolean;
  onRunAgain: () => void;
  label: string;
  localFailed?: boolean;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [warning, setWarning] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function requestRerun() {
    if (!runId) {
      onRunAgain();
      return;
    }
    setChecking(true);
    try {
      const tasks = await listRemoteTasks(runId);
      if (!mounted.current) return;
      if (tasks.some((task) => remoteTaskMayRepeat(task, localFailed)))
        setWarning(true);
      else onRunAgain();
    } catch {
      // A failed local lookup cannot establish that creating new remote work is safe.
      if (mounted.current) setWarning(true);
    } finally {
      if (mounted.current) setChecking(false);
    }
  }
  return (
    <>
      <Button
        variant='outline'
        disabled={disabled || checking}
        onClick={() => void requestRerun()}
      >
        {checking ? <Spinner /> : <RotateCcwIcon data-icon='inline-start' />}
        {label}
      </Button>
      <AlertDialog open={warning} onOpenChange={setWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('workflowEditor.remoteTasks.rerunTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workflowEditor.remoteTasks.rerunDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('apps.new.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setWarning(false);
                onRunAgain();
              }}
            >
              {t('workflowEditor.remoteTasks.rerunConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function RemoteTaskStartWarning({
  workflowId,
  onReview,
}: {
  workflowId?: string;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  const warnings = useQuery({
    queryKey: ['remoteTaskWarnings', workflowId],
    queryFn: () => listRemoteTaskWarnings(workflowId!),
    enabled: Boolean(workflowId),
  });
  if (!warnings.data?.length) return null;
  const runs = [
    ...new Map(warnings.data.map((task) => [task.runId, task])).values(),
  ];
  return (
    <Alert className='mx-4 my-2 w-auto'>
      <CircleAlertIcon />
      <AlertTitle>{t('workflowEditor.remoteTasks.previousTitle')}</AlertTitle>
      <AlertDescription>
        <p>{t('workflowEditor.remoteTasks.previousDescription')}</p>
        <div className='flex max-h-48 flex-col gap-2 overflow-auto'>
          {runs.map((task) => (
            <Button
              key={task.runId}
              size='sm'
              variant='outline'
              onClick={() => {
                void inspectRunRecord(task.runId)
                  .then((record) => {
                    onReview();
                    useRunWorkspaceStore.getState().openRun(record);
                  })
                  .catch((error) =>
                    toast.error(String(error), { toasterId: 'global' }),
                  );
              }}
            >
              {t('workflowEditor.remoteTasks.review')} ·{' '}
              {new Date(task.createdAt).toLocaleString()}
            </Button>
          ))}
        </div>
      </AlertDescription>
    </Alert>
  );
}
