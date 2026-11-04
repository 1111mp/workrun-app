import type { QueryClient } from '@tanstack/react-query';

import {
  getSchedulingSession,
  type SchedulingSession,
} from '@/services/schedules';

/** A delayed read or command receipt must never roll the UI back to an older native revision. */
export function latestSchedulingSession(
  previous: SchedulingSession | undefined,
  incoming: SchedulingSession,
) {
  return previous && (previous.revision ?? 0) > (incoming.revision ?? 0)
    ? previous
    : incoming;
}

export async function readSchedulingSession(
  client: QueryClient,
  scope: string,
  id: string,
) {
  const value = await getSchedulingSession(id);
  return latestSchedulingSession(
    client.getQueryData<SchedulingSession>(['scheduling-session', scope, id]),
    value,
  );
}

export async function rememberSchedulingSession(
  client: QueryClient,
  scope: string,
  value: SchedulingSession,
) {
  const queryKey = ['scheduling-session', scope, value.id];
  // Cancel the in-flight read before accepting an authoritative command receipt.
  await client.cancelQueries({ queryKey });
  return client.setQueryData<SchedulingSession>(queryKey, (previous) =>
    latestSchedulingSession(previous, value),
  )!;
}
