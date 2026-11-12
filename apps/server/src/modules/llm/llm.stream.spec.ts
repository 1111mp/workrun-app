import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ChatUsageStream } from './llm.stream';

async function normalize(input: string) {
  // Single-byte chunks exercise UTF-8 and SSE boundaries independently.
  const chunks = [...Buffer.from(input)].map((byte) => Buffer.from([byte]));
  const stream = Readable.from(chunks).pipe(new ChatUsageStream());
  let output = '';
  for await (const chunk of stream) output += chunk.toString();
  return output;
}

describe('Chat usage tail compatibility', () => {
  it('normalizes placeholder choices while preserving streamed text and tools', async () => {
    const text =
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n';
    const tool =
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1"}]},"finish_reason":null}]}\n\n';
    const tail = {
      choices: [{ delta: {}, finish_reason: null }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    };
    const result = await normalize(
      `${text}${tool}data: ${JSON.stringify(tail)}\r\n\r\ndata: [DONE]\n\n`,
    );
    expect(result.startsWith(text + tool)).toBe(true);
    const frame = JSON.parse(result.split('data: ')[3].split('\r\n')[0]);
    expect(frame).toEqual({ ...tail, choices: [] });
    expect(result.endsWith('data: [DONE]\n\n')).toBe(true);
  });
  it('preserves finish responses, content-bearing usage and non-JSON events', async () => {
    const input =
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":6}}\n\n' +
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}],"usage":{"total_tokens":6}}\n\n' +
      ': keepalive\r\n\r\ndata: not-json\n\n';
    expect(await normalize(input)).toBe(input);
  });
});
