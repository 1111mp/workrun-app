import type { Update } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type UpdaterState = {
  open: boolean;
  update: Update | null;

  setOpen(open: boolean): void;
  setUpdate(update: Update | null): void;
};

export const useUpdaterStore = create<UpdaterState>()(
  immer((set) => ({
    open: false,
    update: null,

    setOpen: (open) => {
      set((state) => {
        state.open = open;
      });
    },
    setUpdate: (update) => {
      set((state) => {
        state.update = update;
      });
    },
  })),
);
