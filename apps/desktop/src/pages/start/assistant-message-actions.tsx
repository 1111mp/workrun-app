import { Button } from '@workspace/ui/components';
import {
  CheckIcon,
  CopyIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { AssistantMessage } from '@/services/assistant';

export function AssistantMessageActions({
  text,
  feedback,
  onFeedback,
  disabled,
}: {
  text: string;
  feedback?: AssistantMessage['feedback'];
  onFeedback?: (value: 'helpful' | 'unhelpful') => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(reset.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error(t('assistant.copyFailed'), { toasterId: 'global' });
    }
  };
  return (
    <div className='flex items-center gap-0.5'>
      <Button
        variant='ghost'
        size='icon-xs'
        aria-label={t(copied ? 'assistant.copied' : 'assistant.copy')}
        title={t(copied ? 'assistant.copied' : 'assistant.copy')}
        onClick={() => void copy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
      {onFeedback && (
        <>
          <Button
            variant={feedback === 'helpful' ? 'secondary' : 'ghost'}
            size='icon-xs'
            aria-label={t('assistant.helpful')}
            title={t('assistant.helpful')}
            aria-pressed={feedback === 'helpful'}
            disabled={disabled}
            onClick={() => onFeedback('helpful')}
          >
            <ThumbsUpIcon />
          </Button>
          <Button
            variant={feedback === 'unhelpful' ? 'secondary' : 'ghost'}
            size='icon-xs'
            aria-label={t('assistant.unhelpful')}
            title={t('assistant.unhelpful')}
            aria-pressed={feedback === 'unhelpful'}
            disabled={disabled}
            onClick={() => onFeedback('unhelpful')}
          >
            <ThumbsDownIcon />
          </Button>
        </>
      )}
    </div>
  );
}
