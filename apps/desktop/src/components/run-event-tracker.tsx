import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';

import type { WorkflowRunEventEnvelope } from '@/services/workflow';

/**
 * Keeps durable run queries current independently of whichever page launched a
 * run. Page-specific listeners may still render streaming output optimistically.
 */
function RunEventTracker() {
  const queryClient = useQueryClient();
  const announcedRuns = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    let unlistenRunEvents: (() => void) | undefined;
    let unlistenStatusChanges: (() => void) | undefined;
    let unlistenPendingActions: (() => void) | undefined;

    void listen<WorkflowRunEventEnvelope>('run-event', ({ payload }) => {
      if (announcedRuns.current.has(payload.runId)) return;
      // A run needs one early refresh to enter Run Center. Its output chunks
      // are rendered by the page-local subscriber and must not repeatedly
      // invalidate shell-level history queries while the workflow is running.
      announcedRuns.current.add(payload.runId);
      void queryClient.invalidateQueries({ queryKey: ['run-history'] });
    }).then((stop) => {
      if (disposed) stop();
      else unlistenRunEvents = stop;
    });
    void listen<{ runId: string }>('run-status-changed', ({ payload }) => {
      announcedRuns.current.delete(payload.runId);
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
    };
  }, [queryClient]);

  return null;
}

export { RunEventTracker };
