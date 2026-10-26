import {
  MessageScrollerViewport,
  useMessageScroller,
} from '@workspace/ui/components';
import { useEffect, useRef, type ComponentProps } from 'react';

type Position = { messageId?: string; offset: number; top: number };
// Keep reading positions in this renderer only, isolated by workspace and session.
const positions = new Map<string, Position>();

export function ConversationScrollViewport({
  positionKey,
  ...props
}: ComponentProps<typeof MessageScrollerViewport> & { positionKey: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const { scrollToMessage } = useMessageScroller();
  const saved = useRef(positions.get(positionKey));
  const restoring = useRef(Boolean(saved.current));

  useEffect(() => {
    // Wait for the scroller's initial layout before restoring a message anchor.
    // Anchoring also tolerates messages arriving while the reader is away.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const element = viewport.current;
        const position = saved.current;
        if (element && position) {
          if (
            position.messageId &&
            scrollToMessage(position.messageId, {
              align: 'start',
              behavior: 'instant',
              scrollMargin: 0,
            })
          ) {
            const anchor = Array.from(
              element.querySelectorAll<HTMLElement>('[data-message-id]'),
            ).find((item) => item.dataset.messageId === position.messageId);
            // The scroller's alignment includes content padding; correct from
            // the actual position rather than assuming the anchor is at zero.
            if (anchor)
              element.scrollTop +=
                anchor.getBoundingClientRect().top -
                element.getBoundingClientRect().top -
                position.offset;
          } else {
            element.scrollTop = position.top;
          }
        }
        restoring.current = false;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollToMessage]);

  return (
    <MessageScrollerViewport
      {...props}
      ref={viewport}
      data-conversation-scroll-viewport
      onScroll={(event) => {
        props.onScroll?.(event);
        if (restoring.current) return;
        const element = event.currentTarget;
        const top = element.getBoundingClientRect().top;
        const anchor = Array.from(
          element.querySelectorAll<HTMLElement>('[data-message-id]'),
        ).find((item) => item.getBoundingClientRect().bottom > top);
        positions.delete(positionKey);
        positions.set(positionKey, {
          messageId: anchor?.dataset.messageId,
          offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
          top: element.scrollTop,
        });
        if (positions.size > 50)
          positions.delete(positions.keys().next().value!);
      }}
    />
  );
}
