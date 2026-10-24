import { expect, it } from 'vitest';

import type { AssistantMessage } from '@/services/assistant';

import { groupAssistantMessages } from './assistant-turn';
const message = (
  id: string,
  role: AssistantMessage['role'],
): AssistantMessage => ({
  id,
  role,
  text: id,
  content: { role: role === 'user' ? 'user' : 'model', parts: [{ text: id }] },
});
it('preserves card-only turns between consecutive user messages without inventing stored replies', () => {
  const messages = [
    message('first', 'user'),
    message('second', 'user'),
    message('notice', 'assistant'),
  ];
  const groups = groupAssistantMessages(messages, ['first']);
  expect(groups.map((group) => [group.id, group.role])).toEqual([
    ['first', 'user'],
    ['reply-first', 'assistant'],
    ['second', 'user'],
    ['reply-second', 'assistant'],
  ]);
  expect(groups[1]?.messages).toEqual([]);
  expect(messages).toHaveLength(3);
});
it('does not duplicate an existing answer group when it also contains a card', () => {
  const groups = groupAssistantMessages(
    [message('user', 'user'), message('answer', 'assistant')],
    ['user'],
  );
  expect(groups).toHaveLength(2);
  expect(groups[1]?.messages[0]?.id).toBe('answer');
});
