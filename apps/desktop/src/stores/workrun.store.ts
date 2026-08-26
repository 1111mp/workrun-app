import { isEqual, noop } from 'lodash-es';
import { create } from 'zustand';
import { persist, type PersistStorage } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

import { localProfileAvatarUrl } from '@/lib/avatar';
import { applyPendingTheme } from '@/lib/utils';
import {
  getSystemTheme,
  getWorkrunConfig,
  patchWorkrunConfig,
} from '@/services/cmd';
import type { TeamUser } from '@/services/session';

type WorkrunState = {
  config?: IWorkrunConfig;
  resolvedTheme?: AppBaseTheme;
  teamUser?: TeamUser;
  setTeamUser: (user?: TeamUser) => void;
  updateConfig: (patch: Partial<IWorkrunConfig>) => Promise<void>;
  setResolvedTheme: (theme: AppBaseTheme) => void;
  updateTheme: (theme: AppTheme) => Promise<void>;
};

let previousConfig: IWorkrunConfig | null = null;
let updateConfigPromiseResolver:
  | ((value: void | PromiseLike<void>) => void)
  | null = null;

const storage: PersistStorage<Pick<WorkrunState, 'config' | 'resolvedTheme'>> =
  {
    getItem: async (_name) => {
      const config = await getWorkrunConfig();
      const resolvedTheme =
        config.theme === 'system' ? await getSystemTheme() : config.theme;

      previousConfig = structuredClone(config);

      // if (config.locale) {
      //   void i18n.changeLanguage(config.locale);
      // }

      return {
        state: {
          config,
          resolvedTheme,
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
    immer((set, get) => ({
      config: undefined,
      resolvedTheme: undefined,
      teamUser: undefined,

      setTeamUser: (user) => {
        set((state) => {
          state.teamUser = user;
        });
      },

      updateConfig: async (patch) => {
        const currentConfig = get().config;
        if (
          !currentConfig ||
          isEqual(currentConfig, { ...currentConfig, ...patch })
        ) {
          return;
        }

        const resolvedTheme =
          patch.theme === 'system' ? await getSystemTheme() : patch.theme;
        set((state) => {
          if (!state.config) {
            return;
          }

          Object.assign(state.config, patch);
          if (resolvedTheme) {
            state.resolvedTheme = resolvedTheme;
          }
        });

        await new Promise<void>((resolve) => {
          updateConfigPromiseResolver = resolve;
        });
      },

      setResolvedTheme: (theme) => {
        set((state) => {
          state.resolvedTheme = theme;
        });
      },

      updateTheme: async (theme) => {
        await get().updateConfig({ theme });
        await applyPendingTheme(theme);
      },
    })),
    {
      name: 'workrun-store',
      storage,
    },
  ),
);

type WorkspaceUserInfo = {
  avatarUrl?: string | null;
  name: string;
};

function selectWorkspaceUserInfo(
  state: WorkrunState,
): WorkspaceUserInfo | undefined {
  if (state.config?.workspace_mode === 'team') {
    const user = state.teamUser;
    return user && { avatarUrl: user.image, name: user.name };
  }

  const profile = state.config?.local_profile;
  return (
    profile && {
      avatarUrl: localProfileAvatarUrl(profile.avatar_id),
      name: profile.display_name,
    }
  );
}

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

export { selectWorkspaceUserInfo };
