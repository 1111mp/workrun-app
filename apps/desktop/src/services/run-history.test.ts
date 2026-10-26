import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, it, vi } from 'vitest';

import { inspectRunRecord } from './run-history';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it('reconstructs events and spans from bounded pages using the inspection snapshot cursor', async () => {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as Record<string, unknown>;
    if (command === 'run_history_inspect')
      return {
        id: 'run',
        lastSequence: 201,
        lastSpanId: 'b',
        events: [],
        spans: [],
      };
    if (command === 'run_history_events_page') {
      expect(input.through).toBe(201);
      if (input.after === -1)
        return {
          items: Array.from({ length: 200 }, (_, sequence) => ({
            sequence,
            event: {},
            createdAt: 'now',
          })),
          nextCursor: 199,
        };
      expect(input.after).toBe(199);
      return {
        items: [
          { sequence: 200, event: {}, createdAt: 'now' },
          { sequence: 201, event: {}, createdAt: 'now' },
        ],
        nextCursor: null,
      };
    }
    if (command === 'run_history_spans_page') {
      expect(input.through).toBe('b');
      return input.after === ''
        ? {
            items: [{ id: 'a', startedAt: '2026-10-26T02:00:00Z' }],
            nextCursor: 'a',
          }
        : {
            items: [{ id: 'b', startedAt: '2026-10-26T01:00:00Z' }],
            nextCursor: null,
          };
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const record = await inspectRunRecord('run');
  expect(record.events).toHaveLength(202);
  expect(record.events.at(-1)?.sequence).toBe(201);
  expect(record.spans.map((span) => span.id)).toEqual(['b', 'a']);
  expect(invoke).toHaveBeenCalledTimes(5);
});
