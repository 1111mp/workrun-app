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
  interactionTurnIds: Iterable<string> = [],
): AssistantTurnGroup[] {
  const groups: AssistantTurnGroup[] = [];
  let turnId = messages[0]?.turnId ?? '';
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
  // A paused turn may contain only a native card, with no model answer at all.
  // Keep that slot after its user message when later user turns arrive.
  const interactionTurns = new Set(interactionTurnIds);
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    if (
      group.role === 'user' &&
      interactionTurns.has(group.turnId) &&
      !(
        groups[index + 1]?.role === 'assistant' &&
        groups[index + 1]?.turnId === group.turnId
      )
    ) {
      groups.splice(index + 1, 0, {
        id: `reply-${group.turnId}`,
        turnId: group.turnId,
        role: 'assistant',
        messages: [],
        progress: [],
      });
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
