import { adaptJsonOutput } from './llm.output';
import type { InferenceParameters } from './llm.schemas';

const schema = {
  type: 'object',
  properties: { route: { type: 'string', enum: ['task', 'conversation'] } },
  required: ['route'],
  additionalProperties: false,
};
const chat = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Hello' }],
  response_format: { type: 'json_schema', json_schema: { schema } },
};

it('adapts configured aliases without changing the original chat or tool history', () => {
  const original = structuredClone(chat);
  const result = adaptJsonOutput(chat, 'other, deepseek-v4-flash');
  expect(result).toMatchObject({
    response_format: { type: 'json_object' },
    messages: [
      ...chat.messages,
      {
        role: 'system',
        content: expect.stringContaining(JSON.stringify(schema)),
      },
    ],
  });
  expect(chat).toEqual(original);
});

it('keeps schemas for other models and ordinary requests unchanged', () => {
  expect(adaptJsonOutput(chat, '')).toBe(chat);
  expect(adaptJsonOutput(chat, 'deepseek-v4')).toBe(chat);
  for (const response_format of [
    undefined,
    null,
    { type: 'json_object' },
    { type: 'text' },
    { type: 'json_schema' },
  ]) {
    const request = { ...chat, response_format };
    expect(adaptJsonOutput(request, chat.model)).toBe(request);
  }
});

it('adapts Responses before LiteLLM bridges it to Chat, preserving existing instructions', () => {
  const request: InferenceParameters = {
    model: chat.model,
    input: 'Hello',
    instructions: 'Answer in Chinese.',
    text: {
      verbosity: 'low',
      format: { type: 'json_schema', name: 'route', schema },
    },
  };
  expect(adaptJsonOutput(request, chat.model)).toMatchObject({
    input: 'Hello',
    text: { verbosity: 'low', format: { type: 'json_object' } },
    instructions: `Answer in Chinese.\n\nReturn only a JSON object conforming to this JSON Schema:\n${JSON.stringify(schema)}`,
  });
});
