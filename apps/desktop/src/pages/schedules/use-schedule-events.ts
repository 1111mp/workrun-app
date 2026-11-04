import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';

/** Subscribe before reconciling once; no refresh timers run between native events. */
export function useScheduleEvents(scope: string) {
  const client = useQueryClient();
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const refresh = async (keys: readonly (readonly unknown[])[]) => {
      // Discard reads started before this notification so they cannot hide a committed change.
      await Promise.all(
        keys.map((queryKey) => client.cancelQueries({ queryKey })),
      );
      if (!disposed)
        await Promise.all(
          keys.map((queryKey) => client.invalidateQueries({ queryKey })),
        );
    };
    // The renderer scope is an account cache key, not the native workspace ID.
    // Notifications invalidate active-workspace reads rather than importing event data.
    const taskKeys = [
      ['schedules', scope],
      ['schedule', scope],
      ['app-schedules'],
      ['workflow-schedules'],
    ] as const;
    const keep = (stop: () => void) => (disposed ? stop() : stops.push(stop));
    const registrations = [
      listen<{ workspaceId: string }>('schedules-changed', () => {
        if (!disposed) void refresh(taskKeys);
      }).then(keep),
      listen<{ workspaceId: string; sessionId: string }>(
        'schedule-session-changed',
        ({ payload }) => {
          if (!disposed)
            void refresh([
              ['scheduling-sessions', scope],
              ['scheduling-session', scope, payload.sessionId],
            ]);
        },
      ).then(keep),
      listen('run-status-changed', () => {
        if (!disposed) void refresh(taskKeys);
      }).then(keep),
    ];
    void Promise.allSettled(registrations).then((results) => {
      if (disposed) return;
      for (const result of results)
        if (result.status === 'rejected')
          console.error('Schedule event registration failed', result.reason);
      void refresh([
        ...taskKeys,
        ['scheduling-sessions', scope],
        ['scheduling-session', scope],
      ]);
    });
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [client, scope]);
}
