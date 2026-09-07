import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';

/**
 * Keeps durable run queries current independently of whichever page launched a
 * run. Page-specific listeners may still render streaming output optimistically.
 */
function RunEventTracker() {
  const queryClient = useQueryClient();
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    let disposed = false;
    let unlistenRunEvents: (() => void) | undefined;
    let unlistenStatusChanges: (() => void) | undefined;
    let unlistenPendingActions: (() => void) | undefined;

    void listen('run-event', () => {
      if (refreshTimer.current) return;
      // Output arrives in small chunks. A brief coalescing window keeps detail
      // views live without forcing every run-history query on each chunk.
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void queryClient.invalidateQueries({ queryKey: ['run-history'] });
      }, 150);
    }).then((stop) => {
      if (disposed) stop();
      else unlistenRunEvents = stop;
    });
    void listen('run-status-changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['run-history'] });
    }).then((stop) => {
      if (disposed) stop();
      else unlistenStatusChanges = stop;
    });
    void listen('pending-action-created', () => {
      void queryClient.invalidateQueries({ queryKey: ['run-history'] });
    }).then((stop) => {
      if (disposed) stop();
      else unlistenPendingActions = stop;
    });

    return () => {
      disposed = true;
      unlistenRunEvents?.();
      unlistenStatusChanges?.();
      unlistenPendingActions?.();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [queryClient]);

  return null;
}

export { RunEventTracker };
