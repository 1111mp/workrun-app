import { expect, it } from 'vitest';

import type { AssistantMessage } from '@/services/assistant';

import { groupAssistantMessages } from './assistant-turn';

const message = (
  id: string,
  role: AssistantMessage['role'],
  text: string,
): AssistantMessage => ({ id, role, text, content: { role, parts: [] } });
it('presents preamble, workflow and final answer as one assistant turn', () => {
  const groups = groupAssistantMessages([
    message('u1', 'user', 'Create a report'),
    message('a1', 'assistant', 'I will find the reporting workflow'),
    { ...message('t1', 'tool', 'completed'), runId: 'run1' },
    message('a2', 'assistant', 'Your report is ready'),
    message('u2', 'user', 'Did it succeed?'),
    message('a3', 'assistant', 'Yes'),
  ]);
  expect(groups.map((group) => group.id)).toEqual([
    'u1',
    'reply-u1',
    'u2',
    'reply-u2',
  ]);
  expect(groups[1].progress.map((item) => item.id)).toEqual(['a1']);
  expect(groups[1].messages.map((item) => item.id)).toEqual(['t1', 'a2']);
  expect(groups[3].messages[0].text).toBe('Yes');
});
it('keeps pending function-call text in the activity area', () => {
  const preamble = message('a', 'assistant', 'Preparing');
  preamble.content.parts = [{ name: 'execute_workflow', args: {} }];
  const groups = groupAssistantMessages([
    message('u', 'user', 'Run'),
    preamble,
  ]);
  expect(groups[1].progress).toEqual([preamble]);
  expect(groups[1].messages).toEqual([]);
});
