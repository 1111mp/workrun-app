import { Spinner } from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function AssistantTurnActivity({
  summaries,
  busy,
}: {
  summaries: string[];
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const items = summaries.map((text) => text.trim()).filter(Boolean);
  const latest = items.at(-1) ?? '';
  const canExpand = items.length > 0;
  useEffect(() => {
    if (expanded && following.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [latest, expanded]);
  if (!busy) return null;
  return (
    <div className='text-muted-foreground mb-3 text-sm'>
      <button
        type='button'
        aria-expanded={expanded && canExpand}
        disabled={!canExpand}
        onClick={() => setExpanded(!expanded)}
        className='flex w-full min-w-0 items-center gap-2 rounded-md py-2 text-left focus-visible:outline-2'
      >
        {busy && <Spinner className='size-3.5 shrink-0' />}
        <span className='shrink-0'>{t('assistant.progressThinking')}</span>
        {!expanded && <span className='min-w-0 flex-1 truncate'>{latest}</span>}
        {canExpand && (
          <ChevronDownIcon
            className={cn(
              'size-4 shrink-0 transition-transform',
              expanded && 'rotate-180',
            )}
          />
        )}
      </button>
      {expanded && canExpand && (
        <div
          ref={viewport}
          onScroll={() => {
            const el = viewport.current;
            if (el)
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className='border-border flex max-h-48 flex-col gap-3 overflow-y-auto border-l pl-4'
          role='region'
          aria-label={t('assistant.progressSummary')}
        >
          {items.map((text, index) => (
            <p className='break-words whitespace-pre-wrap' key={index}>
              {text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
