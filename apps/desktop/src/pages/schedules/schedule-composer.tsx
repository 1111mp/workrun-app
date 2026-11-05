import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@workspace/ui/components';
import { ArrowUpIcon, SquareIcon, LoaderCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AssistantModelSelector } from '@/components/assistant-model-selector';

export function ScheduleComposer({
  text,
  onTextChange,
  onSubmit,
  models,
  modelId,
  onModelChange,
  effort,
  onEffortChange,
  active,
  onStop,
  canStop,
  modifying,
  answering = false,
  responding = active,
}: {
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: () => void;
  models: ModelDefinition[];
  modelId: string;
  onModelChange: (id: string) => void;
  effort?: ReasoningEffort;
  onEffortChange: (effort?: ReasoningEffort) => void;
  active: boolean;
  onStop: () => void;
  canStop: boolean;
  modifying: boolean;
  answering?: boolean;
  responding?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <form
      className='w-full'
      onSubmit={(event) => {
        event.preventDefault();
        // Keep drafts editable while the current response owns the conversation.
        if (!active) onSubmit();
      }}
    >
      <InputGroup
        data-workrun-composer
        className='rounded-2xl has-disabled:opacity-100'
      >
        <InputGroupTextarea
          rows={2}
          aria-label={t('schedules.composer')}
          placeholder={t(
            answering
              ? 'schedules.answerPlaceholder'
              : modifying
                ? 'schedules.modifyPlaceholder'
                : 'schedules.createPlaceholder',
          )}
          className='max-h-40 min-h-16 px-4 py-3 leading-6'
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter must finish IME composition before it can send a Chinese message.
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <InputGroupAddon
          align='block-end'
          className='justify-between px-3 pb-2'
        >
          <div className='flex min-w-0 items-center gap-2'>
            <AssistantModelSelector
              models={models}
              modelId={modelId}
              effort={effort}
              onModelChange={onModelChange}
              onEffortChange={onEffortChange}
              disabled={active}
            />
          </div>
          {active && !responding ? (
            <InputGroupButton
              size='icon-sm'
              variant='outline'
              disabled
              aria-label={t('schedules.updating')}
            >
              <LoaderCircleIcon className='animate-spin' />
            </InputGroupButton>
          ) : active ? (
            <InputGroupButton
              size='icon-sm'
              variant='outline'
              aria-label={t('schedules.stop')}
              disabled={!canStop}
              onClick={onStop}
            >
              <SquareIcon />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type='submit'
              size='icon-sm'
              variant='default'
              aria-label={t('schedules.send')}
              disabled={!text.trim() || !modelId}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
      <p className='text-muted-foreground mt-3 text-center text-xs leading-5'>
        {!modelId ? t('schedules.selectModel') : t('schedules.localHint')}
      </p>
    </form>
  );
}
