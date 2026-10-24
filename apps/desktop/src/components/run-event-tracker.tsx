import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';

import type { WorkflowRunEventEnvelope } from '@/services/workflow';
import { useRunWorkspaceStore } from '@/stores/run-workspace.store';

/**
 * Keeps durable run queries current independently of whichever page launched a
 * run. Page-specific listeners may still render streaming output optimistically.
 */
function RunEventTracker() {
  const queryClient = useQueryClient();
  const announcedRuns = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    const changedRuns = new Set<string>();
    let detailRefresh: ReturnType<typeof setTimeout> | undefined;
    const refreshDetails = () => {
      detailRefresh = undefined;
      const ids = new Set(changedRuns);
      changedRuns.clear();
      // Only open run details need token-level updates; lists refresh on status.
      const details = queryClient.getQueryCache().findAll({
        predicate: ({ queryKey }) =>
          queryKey[0] === 'run-history' &&
          (ids.has(queryKey[1] as string) ||
            (queryKey[1] === 'assistant-inline' &&
              ids.has(queryKey[3] as string))),
      });
      for (const query of details) {
        const filters = { queryKey: query.queryKey, exact: true };
        // An initial IPC read may still be pending when completion is pushed.
        // Cancel its cache result so a stale first response cannot hide that event.
        void queryClient.cancelQueries(filters).then(() => {
          if (!disposed) void queryClient.invalidateQueries(filters);
        });
      }
    };

    const stops: (() => void)[] = [];
    const keepListener = (stop: () => void) => {
      if (disposed) stop();
      else stops.push(stop);
    };

    const runEvents = listen<WorkflowRunEventEnvelope>(
      'run-event',
      ({ payload }) => {
        if (disposed) return;
        useRunWorkspaceStore.getState().noteEvent(payload.runId);
        changedRuns.add(payload.runId);
        // Batch bursts from pushed tokens. No timer runs without an event.
        detailRefresh ??= setTimeout(refreshDetails, 100);
        const event = payload.event as { type?: string };
        // An interaction event can precede its checkpoint write. Recheck cards
        // when the graph confirms the durable pause, even for an announced run.
        if (event?.type === 'interrupted') {
          void queryClient.invalidateQueries({ queryKey: ['run-history'] });
        }

        if (announcedRuns.current.has(payload.runId)) return;
        // A run needs one early refresh to enter Run Center. Its output chunks
        // update open details separately and must not repeatedly invalidate
        // shell-level history queries while the workflow is running.
        announcedRuns.current.add(payload.runId);
        void queryClient.invalidateQueries({ queryKey: ['run-history'] });
      },
    ).then(keepListener);
    const statusChanges = listen<{ runId: string }>(
      'run-status-changed',
      ({ payload }) => {
        if (disposed) return;
        changedRuns.add(payload.runId);
        detailRefresh ??= setTimeout(refreshDetails, 100);
        announcedRuns.current.delete(payload.runId);
        void queryClient.invalidateQueries({
          queryKey: ['remoteTaskWarnings'],
        });
        void queryClient.invalidateQueries({ queryKey: ['run-history'] });
      },
    ).then(keepListener);
    const pendingActions = listen('pending-action-created', () => {
      void queryClient.invalidateQueries({ queryKey: ['run-history'] });
    }).then(keepListener);
    // Reconcile once after all three listeners are ready, covering the startup
    // registration gap without issuing three identical history reads.
    void Promise.allSettled([runEvents, statusChanges, pendingActions]).then(
      (results) => {
        if (disposed) return;
        for (const result of results)
          if (result.status === 'rejected')
            console.error('Run event registration failed', result.reason);
        void queryClient.invalidateQueries({ queryKey: ['run-history'] });
      },
    );

    // Subscribe before refreshing once, so changes during webview startup are
    // covered even when the initial query completed before listener setup.
    for (const [event, keys] of [
      ['remote-tasks-changed', ['remoteTasks', 'remoteTaskWarnings']],
      ['mcp-servers-changed', ['mcp-servers']],
    ] as const) {
      const refresh = () => {
        for (const key of keys)
          void queryClient.invalidateQueries({ queryKey: [key] });
      };
      void listen(event, refresh).then((stop) => {
        if (disposed) stop();
        else {
          stops.push(stop);
          refresh();
        }
      });
    }

    return () => {
      disposed = true;
      if (detailRefresh) clearTimeout(detailRefresh);
      stops.forEach((stop) => stop());
    };
  }, [queryClient]);

  return null;
}

export { RunEventTracker };
