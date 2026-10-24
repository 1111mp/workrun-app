import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@workspace/ui/components';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageMarkdown } from '@/components/message-markdown';

export function AssistantPlanOutcome({ summary }: { summary: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = summary.length > 280;
  // Old receipts often contain one plain Chinese paragraph. Add visual breaks
  // only at Chinese sentence endings; never split decimal points, paths or keys.
  // Leave Markdown and existing line breaks intact, including inline code.
  const legacy = long && !/[\n`*#<>]|\[[^\]]+\]\(/.test(summary);
  const content = legacy ? (
    <div className='flex flex-col gap-3 leading-7 wrap-anywhere'>
      {summary.match(/[^。]+。?|。/gu)?.map((sentence, index) => (
        <p key={index} className='whitespace-pre-wrap'>
          {sentence}
        </p>
      ))}
    </div>
  ) : (
    <MessageMarkdown content={summary} />
  );

  if (!long)
    return (
      <div className='w-full min-w-0 text-sm' role='status'>
        {content}
      </div>
    );
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className='w-full min-w-0 text-sm'
    >
      {!open &&
        (legacy ? (
          <p className='line-clamp-3 leading-7 wrap-anywhere whitespace-pre-wrap'>
            {summary}
          </p>
        ) : (
          <div className='max-h-21 overflow-hidden' inert>
            {content}
          </div>
        ))}
      <CollapsibleContent>
        <div className='max-w-4xl' data-testid='plan-outcome-details'>
          {content}
        </div>
      </CollapsibleContent>
      <CollapsibleTrigger
        render={<Button variant='ghost' size='sm' className='mt-2' />}
      >
        <ChevronDownIcon
          className={open ? 'rotate-180' : undefined}
          data-icon='inline-start'
        />
        {t(open ? 'assistant.plan.hideOutcome' : 'assistant.plan.viewOutcome')}
      </CollapsibleTrigger>
    </Collapsible>
  );
}
