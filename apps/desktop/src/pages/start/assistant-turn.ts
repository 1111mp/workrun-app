import type { AssistantMessage } from '@/services/assistant';

export type AssistantTurnGroup = {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  messages: AssistantMessage[];
  progress: AssistantMessage[];
};

// Model/tool exchanges remain intact in storage. Presentation follows user
// turns, including historical sessions without explicit turn metadata.
export function groupAssistantMessages(
  messages: AssistantMessage[],
): AssistantTurnGroup[] {
  const groups: AssistantTurnGroup[] = [];
  let turnId = '';
  let reply: AssistantTurnGroup | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      turnId = message.id;
      reply = undefined;
      groups.push({
        id: message.id,
        turnId,
        role: 'user',
        messages: [message],
        progress: [],
      });
    } else {
      if (!reply) {
        reply = {
          id: `reply-${turnId}`,
          turnId,
          role: 'assistant',
          messages: [],
          progress: [],
        };
        groups.push(reply);
      }
      reply.messages.push(message);
    }
  }
  for (const group of groups) {
    if (group.role === 'user') continue;
    const lastTool = group.messages.findLastIndex(
      (message) => message.role === 'tool',
    );
    group.progress = group.messages.filter(
      (message, index) =>
        message.role === 'assistant' &&
        (index < lastTool ||
          message.content.parts.some(
            (part) =>
              typeof part === 'object' &&
              part !== null &&
              ('functionCall' in part || ('name' in part && 'args' in part)),
          )),
    );
    group.messages = group.messages.filter(
      (message) => !group.progress.includes(message),
    );
  }
  return groups;
}
