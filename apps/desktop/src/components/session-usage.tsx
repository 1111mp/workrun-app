import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  Progress,
  Skeleton,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import { ActivityIcon, ChevronDownIcon, InfoIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getSessionUsage } from '@/services/model-usage';

export function SessionUsage({
  kind,
  sessionId,
  scope,
}: {
  kind: 'assistant' | 'workflow_chat';
  sessionId: string;
  scope?: string;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['session-usage', scope, kind, sessionId],
    queryFn: () => getSessionUsage(kind, sessionId),
    enabled: open,
    gcTime: 0,
    refetchInterval: open ? 3000 : false,
  });
  const data = query.data;
  const latestTurn = data?.byTurn
    ?.filter((turn) => turn.turnId != null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const number = (value: number | null | undefined) =>
    value == null ? '—' : value.toLocaleString(i18n?.language);
  const total = data
    ? data.conversation.totalTokens + data.execution.totalTokens
    : 0;
  const missing = data
    ? data.conversation.missingUsageCalls + data.execution.missingUsageCalls
    : 0;
  const unfinished = data
    ? data.conversation.unfinishedCalls + data.execution.unfinishedCalls
    : 0;
  const estimated = data
    ? data.conversation.estimatedCalls + data.execution.estimatedCalls
    : 0;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant='ghost' size='sm' />}>
        {t('usage.title')}
      </DialogTrigger>
      <DialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-250! grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:h-[min(82dvh,760px)] sm:w-[calc(100vw-4rem)]'>
        <div className='via-background relative overflow-hidden border-b bg-linear-to-br from-violet-500/12 to-sky-500/10 px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
          <div className='pointer-events-none absolute -top-12 -right-10 size-36 rounded-full bg-violet-500/10 blur-2xl' />
          <DialogHeader className='relative flex-row items-start gap-3 text-left'>
            <span className='flex size-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/10 text-violet-700 shadow-sm dark:text-violet-300'>
              <ActivityIcon className='size-5' />
            </span>
            <div className='flex min-w-0 flex-col gap-1.5 pr-6'>
              <DialogTitle className='text-lg font-semibold tracking-tight'>
                {t('usage.title')}
              </DialogTitle>
              <DialogDescription className='text-sm leading-5'>
                {t('usage.description')}
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>
        <div className='bg-background @container flex min-h-0 min-w-0 flex-col gap-6 overflow-y-auto px-5 py-5 sm:px-6 sm:py-6'>
          {query.isPending && (
            <div role='status' className='flex flex-col gap-3'>
              <span className='sr-only'>{t('usage.loading')}</span>
              <Skeleton className='h-24 w-full' />
              <Skeleton className='h-36 w-full' />
            </div>
          )}
          {query.isError && (
            <Alert variant='destructive'>
              <AlertDescription className='flex items-center justify-between gap-3'>
                {t('usage.error')}
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => void query.refetch()}
                >
                  {t('assistant.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {data?.recordingDegraded && (
            <Alert role='status'>
              <InfoIcon />
              <AlertDescription>
                {t('usage.recordingDegraded')}
              </AlertDescription>
            </Alert>
          )}
          {data &&
            !query.isError &&
            (data.calls.length ? (
              <>
                {(missing > 0 || unfinished > 0 || estimated > 0) && (
                  <Alert role='status'>
                    <InfoIcon />
                    <AlertDescription>
                      {t('usage.coverage', {
                        calls: data.calls.length,
                        missing,
                        unfinished,
                        estimated,
                      })}
                    </AlertDescription>
                  </Alert>
                )}
                <div className='grid min-w-0 gap-5 @3xl:min-h-90 @3xl:grow @3xl:grid-cols-2'>
                  <section
                    aria-label={t('usage.overview')}
                    className='bg-card flex min-w-0 flex-col gap-6 rounded-xl border p-4 sm:p-6'
                  >
                    <div className='flex items-start justify-between gap-3'>
                      <div className='flex flex-col gap-1'>
                        <span className='text-muted-foreground text-xs'>
                          {t('usage.recordedTotal')}
                        </span>
                        <div className='flex items-baseline gap-2'>
                          <strong className='text-4xl font-semibold tracking-tight tabular-nums'>
                            {number(total)}
                          </strong>
                          <span className='text-muted-foreground text-xs'>
                            tokens
                          </span>
                        </div>
                      </div>
                      <Badge variant='secondary'>
                        {t('usage.callCount', { count: data.calls.length })}
                      </Badge>
                    </div>
                    {latestTurn && (
                      <p className='text-muted-foreground text-sm'>
                        {t('usage.latestTurn')}{' '}
                        <strong className='text-foreground font-medium tabular-nums'>
                          {number(
                            latestTurn.conversationTokens +
                              latestTurn.executionTokens,
                          )}
                        </strong>{' '}
                        tokens
                      </p>
                    )}
                    <dl className='bg-muted/40 grid grid-cols-2 gap-4 rounded-lg border p-4'>
                      {(['conversation', 'execution'] as const).map((key) => (
                        <div key={key} className='flex flex-col gap-1'>
                          <dt className='text-muted-foreground text-xs'>
                            {t(`usage.${key}`)}
                          </dt>
                          <dd className='text-lg font-semibold tabular-nums'>
                            {number(data[key].totalTokens)}
                          </dd>
                          <dd className='text-muted-foreground text-xs leading-5'>
                            {t(`usage.${key}Hint`)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <dl className='grid grid-cols-2 gap-4'>
                      {(['input', 'output'] as const).map((key) => (
                        <div key={key} className='flex flex-col gap-1'>
                          <dt className='text-muted-foreground text-xs'>
                            {t(`usage.${key}`)}
                          </dt>
                          <dd className='font-medium tabular-nums'>
                            {number(
                              key === 'input'
                                ? data.conversation.inputTokens +
                                    data.execution.inputTokens
                                : data.conversation.outputTokens +
                                    data.execution.outputTokens,
                            )}
                          </dd>
                          <dd className='text-muted-foreground text-xs leading-5'>
                            {t(`usage.${key}Hint`)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                  <section
                    className='bg-card flex min-w-0 flex-col gap-5 rounded-xl border p-4 sm:p-6'
                    aria-label={t('usage.breakdown')}
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <h3 className='text-sm font-medium'>
                        {t('usage.breakdown')}
                      </h3>
                      <span className='text-muted-foreground text-xs'>
                        {t('usage.shareHint')}
                      </span>
                    </div>
                    {[...data.byPurpose]
                      .sort((a, b) => b.totalTokens - a.totalTokens)
                      .map((item) => {
                        const label = t(`usage.purposes.${item.purpose}`, {
                          defaultValue: item.purpose,
                        });
                        const share =
                          total > 0 ? (item.totalTokens / total) * 100 : 0;
                        return (
                          <div
                            key={item.purpose}
                            className='flex flex-col gap-1.5'
                          >
                            <div className='flex items-center justify-between gap-3 text-xs'>
                              <div className='flex min-w-0 items-center gap-2'>
                                <span className='truncate'>{label}</span>
                                <span className='text-muted-foreground shrink-0'>
                                  {t('usage.callCount', { count: item.calls })}
                                </span>
                              </div>
                              <span className='shrink-0 tabular-nums'>
                                {number(item.totalTokens)}{' '}
                                <span className='text-muted-foreground ml-2 inline-block w-12 text-right'>
                                  {share.toLocaleString(i18n?.language, {
                                    maximumFractionDigits: 1,
                                  })}
                                  %
                                </span>
                              </span>
                            </div>
                            <Progress value={share} aria-label={label} />
                          </div>
                        );
                      })}
                  </section>
                </div>
                <Collapsible className='flex flex-col gap-3'>
                  <CollapsibleTrigger
                    render={
                      <Button
                        variant='outline'
                        className='group w-full justify-between'
                      />
                    }
                  >
                    {t('usage.calls')}
                    <ChevronDownIcon className='transition-transform group-data-panel-open:rotate-180' />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div
                      className='overflow-x-auto'
                      role='region'
                      aria-label={t('usage.calls')}
                      tabIndex={0}
                    >
                      <table className='w-full min-w-160 text-left text-xs'>
                        <caption className='sr-only'>
                          {t('usage.calls')}
                        </caption>
                        <thead>
                          <tr>
                            {[
                              'time',
                              'purpose',
                              'model',
                              'input',
                              'output',
                              'total',
                              'status',
                            ].map((key) => (
                              <th
                                key={key}
                                scope='col'
                                className={cn(
                                  'text-muted-foreground px-2 py-2 font-medium',
                                  ['input', 'output', 'total'].includes(key) &&
                                    'text-right',
                                )}
                              >
                                {t(`usage.${key}`)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {data.calls.map((call) => (
                            <tr
                              key={call.id}
                              className='hover:bg-muted/40 border-t'
                            >
                              <td className='px-2 py-2 whitespace-nowrap'>
                                {new Date(call.startedAt).toLocaleTimeString()}
                              </td>
                              <td className='px-2 py-2'>
                                {t(`usage.purposes.${call.context.purpose}`, {
                                  defaultValue: call.context.purpose,
                                })}
                                {call.context.nodeId && (
                                  <div className='text-muted-foreground'>
                                    {call.context.nodeId}
                                  </div>
                                )}
                                {call.context.turnId && (
                                  <div title={call.context.turnId}>
                                    {t('usage.turn', {
                                      id: call.context.turnId.slice(0, 8),
                                    })}
                                  </div>
                                )}
                              </td>
                              <td className='max-w-40 px-2 py-2 wrap-break-word'>
                                {call.model}
                              </td>
                              <td className='px-2 py-2 text-right tabular-nums'>
                                {number(call.usage?.inputTokens)}
                              </td>
                              <td className='px-2 py-2 text-right tabular-nums'>
                                {number(call.usage?.outputTokens)}
                              </td>
                              <td className='px-2 py-2 text-right tabular-nums'>
                                {number(call.usage?.totalTokens)}
                                {call.usage?.totalTokensEstimated ? ' ≈' : ''}
                              </td>
                              <td className='px-2 py-2'>
                                {t(`usage.statuses.${call.status}`, {
                                  defaultValue: call.status,
                                })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
                <p className='text-muted-foreground text-xs leading-5'>
                  {t('usage.accountingHint')}
                </p>
              </>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyDescription>{t('usage.empty')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ))}
        </div>
        <div className='text-muted-foreground bg-muted/30 border-t px-5 py-3 text-xs sm:px-6'>
          {t('usage.refreshHint')}
        </div>
      </DialogContent>
    </Dialog>
  );
}
