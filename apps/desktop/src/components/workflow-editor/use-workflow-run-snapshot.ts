import type { Node } from '@xyflow/react';
import { useEffect, useRef } from 'react';

import type { RunRecord } from '@/services/run-history';
import {
  workflowDocumentFromSnapshot,
  type WorkflowRunEvent,
} from '@/services/workflow';
import {
  replayWorkflowRunProjection,
  useWorkflowRunStore,
} from '@/stores/workflow-run.store';

/** Seed once, then append newer durable events without replacing live rows. */
export function useWorkflowRunSnapshot(
  record: RunRecord | undefined,
  nodes: Node[],
  mode: WorkflowMode,
  live: boolean,
) {
  const restored = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!record) {
      restored.current = undefined;
      return;
    }
    const identity = `${record.id}:${live ? 'live' : 'history'}`;
    // Query invalidations and canvas selection must not rewind streamed text,
    // replace row identities, or replay presentation animations.
    const document = workflowDocumentFromSnapshot(record.targetSnapshot);
    const initialState = (
      record.runtime as { initialState?: Record<string, unknown> }
    )?.initialState;
    const context = {
      mode: document?.settings.mode ?? mode,
      nodes: document?.nodes ?? nodes,
      input: record.input ?? initialState,
      turnId: `history:${record.id}`,
    };
    const events = record.events.map(({ sequence, event }) => ({
      runId: record.id,
      sequence,
      event: event as WorkflowRunEvent,
    }));
    const store = useWorkflowRunStore.getState();
    if (restored.current === identity) {
      // Ignore an older entry record after the user starts another run.
      if (store.projection.runId !== record.id) return;
      const newer = events.filter(
        (event) => event.sequence > store.projection.eventSequence,
      );
      if (newer.length) store.applyRunEvents(newer, context);
      return;
    }
    restored.current = identity;
    store.restoreWorkflowRun(
      replayWorkflowRunProjection(record.id, events, context),
      false,
    );
  }, [record, nodes, mode, live]);
}
