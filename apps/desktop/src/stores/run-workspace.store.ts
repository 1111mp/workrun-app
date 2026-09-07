import { create } from 'zustand';

import type { RunRecordSummary } from '@/services/run-history';

export type RunWorkspaceTab = Pick<
  RunRecordSummary,
  'id' | 'targetType' | 'targetName' | 'status'
> & {
  pinned: boolean;
  unreadEvents: number;
};

type RunWorkspaceState = {
  tabs: RunWorkspaceTab[];
  activeRunId?: string;
  open: boolean;
  openRun: (run: RunRecordSummary) => void;
  closeRun: (runId: string) => void;
  focusRun: (runId: string) => void;
  togglePinned: (runId: string) => void;
  noteEvent: (runId: string) => void;
  setOpen: (open: boolean) => void;
};

/**
 * Run tabs are presentation state only: closing one must never affect the
 * native run that owns its process or workflow session.
 */
export const useRunWorkspaceStore = create<RunWorkspaceState>()((set) => ({
  tabs: [],
  open: false,
  openRun: (run) =>
    set((state) => {
      const existing = state.tabs.find((tab) => tab.id === run.id);
      const tabs = existing
        ? state.tabs.map((tab) =>
            tab.id === run.id
              ? {
                  ...tab,
                  status: run.status,
                  targetName: run.targetName,
                  unreadEvents: 0,
                }
              : tab,
          )
        : [
            ...state.tabs,
            {
              id: run.id,
              targetType: run.targetType,
              targetName: run.targetName,
              status: run.status,
              pinned: false,
              unreadEvents: 0,
            },
          ];
      return { tabs, activeRunId: run.id, open: true };
    }),
  closeRun: (runId) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === runId);
      const tabs = state.tabs.filter((tab) => tab.id !== runId);
      const activeRunId =
        state.activeRunId === runId
          ? tabs[Math.min(index, tabs.length - 1)]?.id
          : state.activeRunId;
      return { tabs, activeRunId, open: tabs.length > 0 && state.open };
    }),
  focusRun: (runId) =>
    set((state) => ({
      activeRunId: runId,
      open: true,
      tabs: state.tabs.map((tab) =>
        tab.id === runId ? { ...tab, unreadEvents: 0 } : tab,
      ),
    })),
  togglePinned: (runId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === runId ? { ...tab, pinned: !tab.pinned } : tab,
      ),
    })),
  noteEvent: (runId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === runId
          ? {
              ...tab,
              unreadEvents:
                tab.id === state.activeRunId ? 0 : tab.unreadEvents + 1,
            }
          : tab,
      ),
    })),
  setOpen: (open) => set({ open }),
}));
