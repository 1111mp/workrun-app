import { isEqual, noop } from 'lodash-es';
import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

import { applyPendingTheme } from '@/lib/utils';
import { getWorkrunConfig, patchWorkrunConfig } from '@/services/cmd';

type WorkrunState = {
  config?: IWorkrunConfig;
  updateConfig: (patch: Partial<IWorkrunConfig>) => Promise<void>;
  updateTheme: (theme: AppTheme) => Promise<void>;
};

let previousConfig: IWorkrunConfig | null = null;
let updateConfigPromiseResolver:
  | ((value: void | PromiseLike<void>) => void)
  | null = null;

const storage: PersistStorage<Pick<WorkrunState, 'config'>> = {
  getItem: async (_name) => {
    const config = await getWorkrunConfig();

    previousConfig = structuredClone(config);

    // if (config.locale) {
    //   void i18n.changeLanguage(config.locale);
    // }

    return {
      state: {
        config,
      },
      version: 0,
    };
  },
  setItem: async (_name, value) => {
    const config = value.state.config;
    if (!config) return;

    if (!previousConfig) {
      previousConfig = structuredClone(config);
      return;
    }
    const patch = createConfigPatch(previousConfig, config);
    if (Object.keys(patch).length === 0) {
      return;
    }

    await patchWorkrunConfig(patch);

    previousConfig = structuredClone(config);

    updateConfigPromiseResolver?.();

    updateConfigPromiseResolver = null;
  },
  removeItem: noop,
};

export const useWorkrunStore = create<WorkrunState>()(
  persist(
    immer((set) => ({
      config: undefined,

      updateConfig: async (patch) => {
        set((state) => {
          if (!state.config) {
            return;
          }

          Object.assign(state.config, patch);
        });

        await new Promise<void>((resolve) => {
          updateConfigPromiseResolver = resolve;
        });
      },

      updateTheme: async (theme) => {
        set((state) => {
          if (state.config) {
            state.config.theme = theme;
          }
        });

        await applyPendingTheme(theme);
      },
    })),
    {
      name: 'workrun-store',
      storage,
    },
  ),
);

/**
 * Create config patch
 *
 * Only return changed fields.
 */
function createConfigPatch(
  oldConfig: IWorkrunConfig,
  newConfig: IWorkrunConfig,
): Partial<IWorkrunConfig> {
  const patch: Partial<IWorkrunConfig> = {};

  for (const key of Object.keys(newConfig) as Array<keyof IWorkrunConfig>) {
    if (!isEqual(oldConfig[key], newConfig[key])) {
      patch[key] = newConfig[key] as never;
    }
  }

  return patch;
}
