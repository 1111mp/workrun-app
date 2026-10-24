import { MessageMarkdown } from '@/components/message-markdown';
import { useTypewriterText } from '@/hooks/use-typewriter-text';

export function AssistantMessageText({
  text,
  animate,
}: {
  text: string;
  animate: boolean;
}) {
  const visible = useTypewriterText(text, animate);
  return (
    <div aria-busy={visible !== text} className='max-w-full min-w-0'>
      <MessageMarkdown content={visible} />
    </div>
  );
}
