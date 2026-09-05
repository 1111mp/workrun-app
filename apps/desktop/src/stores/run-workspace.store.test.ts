import { beforeEach, describe, expect, it } from 'vitest';

import type { RunRecordSummary } from '@/services/run-history';

import { useRunWorkspaceStore } from './run-workspace.store';

const firstRun: RunRecordSummary = {
  id: 'run-1',
  targetType: 'workflow',
  targetId: 'workflow-1',
  targetName: 'First workflow',
  status: 'running',
  startedAt: '2026-09-05T00:00:00Z',
};

const secondRun: RunRecordSummary = {
  ...firstRun,
  id: 'run-2',
  targetId: 'workflow-2',
  targetName: 'Second workflow',
};

beforeEach(() => {
  useRunWorkspaceStore.setState({
    tabs: [],
    activeRunId: undefined,
    open: false,
  });
});

describe('RunWorkspaceStore', () => {
  it('focuses an existing run instead of opening duplicate tabs', () => {
    const store = useRunWorkspaceStore.getState();
    store.openRun(firstRun);
    store.openRun(secondRun);
    useRunWorkspaceStore.getState().noteEvent(firstRun.id);
    useRunWorkspaceStore.getState().openRun(firstRun);

    const state = useRunWorkspaceStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeRunId).toBe(firstRun.id);
    expect(state.tabs.find((tab) => tab.id === firstRun.id)?.unreadEvents).toBe(
      0,
    );
  });

  it('keeps background runs alive while tabs are closed and tracks unread events', () => {
    const store = useRunWorkspaceStore.getState();
    store.openRun(firstRun);
    store.openRun(secondRun);
    store.noteEvent(firstRun.id);
    store.togglePinned(firstRun.id);
    store.closeRun(secondRun.id);

    const state = useRunWorkspaceStore.getState();
    expect(state.tabs).toEqual([
      expect.objectContaining({
        id: firstRun.id,
        pinned: true,
        unreadEvents: 1,
      }),
    ]);
    expect(state.activeRunId).toBe(firstRun.id);
    expect(state.open).toBe(true);
  });
});
