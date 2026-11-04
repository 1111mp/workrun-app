import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';

import {
  getSchedulingSession,
  type SchedulingSession,
} from '@/services/schedules';

import {
  readSchedulingSession,
  rememberSchedulingSession,
} from './session-cache';

vi.mock('@/services/schedules', () => ({ getSchedulingSession: vi.fn() }));
const snapshot = (revision: number): SchedulingSession => ({
  id: 'session',
  revision,
  title: 'Weather',
  status: 'idle',
  messages: [{ id: 'answer', role: 'assistant', text: `Answer ${revision}` }],
  proposals: [],
  questions: [],
});
const key = ['scheduling-session', 'workspace', 'session'];

it('rejects both an older read and an older mutation receipt after a newer event snapshot', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(key, snapshot(3));
  vi.mocked(getSchedulingSession).mockResolvedValue(snapshot(2));
  const value = await readSchedulingSession(client, 'workspace', 'session');
  expect(value.revision).toBe(3);
  await rememberSchedulingSession(client, 'workspace', snapshot(1));
  expect(client.getQueryData<SchedulingSession>(key)?.revision).toBe(3);
  client.clear();
});

it('cancels a pending read without exposing loading, losing current data or leaving fetchStatus stuck', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(key, snapshot(1));
  let resolve!: (value: SchedulingSession) => void;
  vi.mocked(getSchedulingSession).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const read = client
    .fetchQuery({
      queryKey: key,
      queryFn: () => readSchedulingSession(client, 'workspace', 'session'),
    })
    .catch(() => undefined);
  await rememberSchedulingSession(client, 'workspace', snapshot(2));
  expect(client.getQueryState(key)?.status).toBe('success');
  expect(client.getQueryState(key)?.fetchStatus).toBe('idle');
  resolve(snapshot(1));
  await read;
  expect(client.getQueryData<SchedulingSession>(key)?.revision).toBe(2);
  client.clear();
});
