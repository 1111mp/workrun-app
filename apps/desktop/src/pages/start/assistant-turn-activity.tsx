import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@workspace/ui/components';
import { BrainIcon, CircleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AssistantReasoning,
  AssistantSession,
} from '@/services/assistant';

export function AssistantTurnThinking({
  session,
  turnId,
  busy,
}: {
  session: AssistantSession;
  turnId: string;
  busy: boolean;
}) {
  const reasoning = (session.reasoning ?? []).filter(
    (item) => item.turnId === turnId,
  );
  const activities = (session.activities ?? []).filter(
    (item) => item.turnId === turnId,
  );
  const phases = new Set([
    ...reasoning.map((item) => item.phaseId),
    ...activities.map((item) => item.phaseId ?? ''),
    ...(busy ? [session.responsePhaseId ?? ''] : []),
  ]);
  return (
    <div className='flex flex-col gap-3'>
      {[...phases].map((phaseId) => (
        <AssistantTurnActivity
          key={phaseId}
          reasoning={reasoning.filter((item) => item.phaseId === phaseId)}
          summaries={activities
            .filter((item) => (item.phaseId ?? '') === phaseId)
            .map((item) => item.summary)}
          busy={busy && phaseId === (session.responsePhaseId ?? '')}
          failed={
            session.status === 'error' && phaseId === session.responsePhaseId
          }
        />
      ))}
    </div>
  );
}

export function AssistantTurnActivity({
  summaries,
  reasoning = [],
  busy,
  failed = false,
}: {
  summaries: string[];
  reasoning?: AssistantReasoning[];
  busy: boolean;
  failed?: boolean;
}) {
  const { t } = useTranslation();
  // Automatic expansion follows generation until the reader chooses otherwise.
  const [open, setOpen] = useState<boolean>();
  // Progress reports describe a moment in time, so they stop being a status
  // when the phase ends. Only provider thinking remains available for review.
  const items = busy
    ? summaries.map((text) => text.trim()).filter(Boolean)
    : [];
  const thoughts = reasoning.filter((item) => item.text.trim());
  const hasContent = items.length > 0 || thoughts.length > 0;
  if (!busy && !hasContent) return null;
  const duration = thoughts.reduce((total, item) => total + item.durationMs, 0);
  const title = t(
    failed
      ? 'assistant.thinkingInterrupted'
      : busy
        ? 'assistant.progressThinking'
        : thoughts.length
          ? 'assistant.thinkingComplete'
          : 'assistant.progressComplete',
  );
  const line = (
    <TraceLine status={failed ? 'error' : busy ? 'running' : undefined}>
      <TraceIcon>{failed ? <CircleAlertIcon /> : <BrainIcon />}</TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      {!busy && duration > 0 && (
        <TraceDescription>
          {t('assistant.thinkingDuration', {
            seconds: Math.max(1, Math.round(duration / 1000)),
          })}
        </TraceDescription>
      )}
    </TraceLine>
  );
  return (
    <Trace className='mb-3' data-testid='assistant-thinking'>
      {hasContent ? (
        <TraceCollapsible open={open ?? busy} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <div
              className='flex min-w-0 flex-col gap-4'
              role='region'
              aria-label={t('assistant.thinkingDetails')}
            >
              {thoughts.map((item) => (
                <p key={item.id} className='wrap-anywhere whitespace-pre-wrap'>
                  {item.text}
                </p>
              ))}
              {items.length > 0 && (
                <div className='flex flex-col gap-2'>
                  <p className='text-xs font-medium'>
                    {t('assistant.progressSummary')}
                  </p>
                  {items.map((text, index) => (
                    <p
                      key={index}
                      className='wrap-anywhere whitespace-pre-wrap'
                    >
                      {text}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        line
      )}
    </Trace>
  );
}
