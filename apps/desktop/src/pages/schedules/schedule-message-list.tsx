import {
  Alert,
  AlertDescription,
  AlertTitle,
  Bubble,
  BubbleContent,
  Message,
  MessageContent,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  useMessageScroller,
} from '@workspace/ui/components';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AssistantMessageActions,
  AssistantMessageFooter,
} from '@/components/assistant-message-actions';
import { AssistantTurnActivity } from '@/components/assistant-turn-activity';
import { conversationContentClassName } from '@/components/conversation-layout';
import { ConversationScrollViewport } from '@/components/conversation-scroll-viewport';
import { AssistantMessageText } from '@/pages/start/assistant-message-text';
import type { AssistantReasoning } from '@/services/assistant';
import type {
  ScheduleProposal,
  SchedulingSession,
  ScheduleQuestion,
} from '@/services/schedules';

import { ProposalCard, Questions, TaskResultCard } from './task-components';

type DisplayRow = SchedulingSession['messages'][number] & {
  previews: ScheduleProposal[];
  results: ScheduleProposal[];
  live?: boolean;
};

type Props = {
  focusProposalId?: string;
  positionKey: string;
  messages: SchedulingSession['messages'];
  proposals: ScheduleProposal[];
  questions: ScheduleQuestion[];
  stream: string;
  activities: string[];
  active: boolean;
  disabled: boolean;
  interrupted: boolean;
  error?: string | null;
  reasoning?: AssistantReasoning[];
  animateFrom?: number;
  resultProposalId?: string;
  onDecision: (id: string, approve: boolean) => void;
  onAnswer: (text: string) => void;
};

export function ScheduleMessageList({
  focusProposalId,
  positionKey,
  messages,
  proposals,
  questions,
  stream,
  activities,
  active,
  disabled,
  interrupted,
  error,
  reasoning = [],
  animateFrom,
  resultProposalId,
  onDecision,
  onAnswer,
}: Props) {
  const { t } = useTranslation();
  // This history is append-only. Its position survives the handoff from an
  // optimistic user ID to the persisted native ID, keeping the DOM and scroll anchor intact.
  const initialCount = useRef(messages.length);
  const animationStart = useRef(animateFrom ?? initialCount.current);
  if (animateFrom !== undefined)
    animationStart.current = Math.min(animationStart.current, animateFrom);
  const visibleMessages =
    active || stream
      ? [
          ...messages,
          { id: 'live', role: 'assistant' as const, text: stream, reasoning },
        ]
      : messages;
  const items: DisplayRow[] = visibleMessages.map((message, index) => ({
    ...message,
    id: `message-${index}`,
    live: active && index === messages.length,
    previews: [] as ScheduleProposal[],
    results: [] as ScheduleProposal[],
  }));
  for (const proposal of proposals) {
    const anchor = (proposal.messageIndex ?? 0) - 1;
    const previewIndex =
      anchor >= 0 && items[anchor]?.role === 'assistant' ? anchor : -1;
    if (previewIndex >= 0) items[previewIndex]!.previews.push(proposal);
    else if (proposal.status === 'waiting')
      items.push({
        id: `proposal-${proposal.id}`,
        role: 'assistant',
        text: '',
        previews: [proposal],
        results: [],
      });
    if (proposal.status !== 'saved') continue;
    let resultIndex = items.findIndex(
      (message) => message.proposalId === proposal.id,
    );
    if (
      resultIndex < 0 &&
      resultProposalId === proposal.id &&
      (active || stream)
    )
      resultIndex = messages.length;
    // Older saved sessions predate explicit receipt identities. Reuse their next
    // assistant answer when available; otherwise supply one task-result reply.
    if (resultIndex < 0 && previewIndex >= 0) {
      const next = items[previewIndex + 1];
      if (next?.role === 'assistant' && !next.proposalId)
        resultIndex = previewIndex + 1;
    }
    if (resultIndex < 0) {
      resultIndex = items.length;
      items.push({
        id: `message-${resultIndex}`,
        role: 'assistant',
        text: '',
        previews: [],
        results: [],
      });
    }
    items[resultIndex]!.results.push(proposal);
  }
  const latestUserId = items.findLast((message) => message.role === 'user')?.id;
  if (
    questions.length &&
    !items.some(
      (row) =>
        row.role === 'assistant' &&
        items.indexOf(row) >
          items.findLastIndex((item) => item.role === 'user'),
    )
  ) {
    items.push({
      id: 'questions',
      role: 'assistant',
      text: '',
      previews: [],
      results: [],
    });
  }
  const questionRow = questions.length
    ? items.findLast((row) => row.role === 'assistant')?.id
    : undefined;
  const latestMessageId = !active && !stream ? items.at(-1)?.id : undefined;
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className='min-h-0 flex-1'>
        <ConversationScrollViewport positionKey={positionKey}>
          <MessageScrollerContent
            className={`${conversationContentClassName} flex flex-col gap-6`}
          >
            {items.map((message, index) => (
              <MessageScrollerItem
                className='[content-visibility:visible]'
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.id === latestUserId}
              >
                <Message align={message.role === 'user' ? 'end' : 'start'}>
                  <MessageContent>
                    {message.role === 'assistant' &&
                      ((message.reasoning?.length ?? 0) > 0 ||
                        (active && message.live)) && (
                        <AssistantTurnActivity
                          summaries={message.live ? activities : []}
                          reasoning={message.reasoning}
                          busy={Boolean(active && message.live)}
                          statusLabel={
                            message.live ? activities.at(-1) : undefined
                          }
                        />
                      )}
                    {message.text && (
                      <Bubble
                        variant={
                          message.role === 'user' ? 'secondary' : 'ghost'
                        }
                      >
                        <BubbleContent>
                          {message.role === 'user' ? (
                            <p className='whitespace-pre-wrap'>
                              {message.text}
                            </p>
                          ) : (
                            <AssistantMessageText
                              key={message.id}
                              text={message.text}
                              animate={index >= animationStart.current}
                            />
                          )}
                        </BubbleContent>
                      </Bubble>
                    )}
                    {message.previews.map((proposal) => (
                      <ProposalCard
                        key={proposal.id}
                        proposal={proposal}
                        disabled={disabled}
                        onDecision={onDecision}
                      />
                    ))}
                    {message.results.map((proposal) => (
                      <TaskResultCard key={proposal.id} proposal={proposal} />
                    ))}
                    {message.id === questionRow && (
                      <Questions
                        key={JSON.stringify(questions)}
                        questions={questions}
                        disabled={disabled}
                        onSubmit={onAnswer}
                      />
                    )}
                    {message.text && !message.live && (
                      <AssistantMessageFooter
                        latest={message.id === latestMessageId}
                      >
                        <AssistantMessageActions text={message.text} />
                      </AssistantMessageFooter>
                    )}
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            ))}
            {interrupted && (
              <MessageScrollerItem
                className='[content-visibility:visible]'
                messageId='interrupted'
              >
                <p role='status' className='text-muted-foreground text-sm'>
                  {t('schedules.interrupted')}
                </p>
              </MessageScrollerItem>
            )}
            {error && (
              <MessageScrollerItem
                className='[content-visibility:visible]'
                messageId='error'
              >
                <Alert variant='destructive'>
                  <AlertTitle>{t('assistant.failed')}</AlertTitle>
                  <AlertDescription>
                    <p>{error}</p>
                  </AlertDescription>
                </Alert>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </ConversationScrollViewport>
        <MessageScrollerButton />
      </MessageScroller>
      <RevealManagementCard
        messageId={
          items.find((row) =>
            row.previews.some((proposal) => proposal.id === focusProposalId),
          )?.id
        }
      />
    </MessageScrollerProvider>
  );
}

/** Explicit detail-dialog actions reveal their new confirmation, even from older history. */
function RevealManagementCard({ messageId }: { messageId?: string }) {
  const { scrollToMessage } = useMessageScroller();
  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (
      messageId &&
      messageId !== revealed.current &&
      scrollToMessage(messageId, { align: 'start', behavior: 'instant' })
    )
      revealed.current = messageId;
  }, [messageId, scrollToMessage]);
  return null;
}
