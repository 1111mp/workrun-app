import { invoke } from '@tauri-apps/api/core';

import {
  syncTeamModelSession,
  teamModelSessionVersion,
} from './team-model-session';

/**
 * Get workrun configuration.
 */
export async function getWorkrunConfig(): Promise<IWorkrunConfig> {
  return invoke<IWorkrunConfig>('get_workrun_config');
}

/**
 * Patch workrun configuration
 */
export async function patchWorkrunConfig(
  payload: Partial<IWorkrunConfig>,
): Promise<void> {
  return invoke('patch_workrun_config', { payload });
}

export type ModelCatalogStatus = {
  models: ModelDefinition[];
  serverError: string | null;
};

export function getModelCatalog(): Promise<ModelDefinition[]> {
  return readModelCatalog(false, false) as Promise<ModelDefinition[]>;
}

export function getModelCatalogStatus(
  refresh = false,
): Promise<ModelCatalogStatus> {
  return readModelCatalog(true, refresh) as Promise<ModelCatalogStatus>;
}

async function readModelCatalog(
  status: boolean,
  refresh: boolean,
): Promise<ModelDefinition[] | ModelCatalogStatus> {
  const version = teamModelSessionVersion();
  const config = await getWorkrunConfig();
  if (config.workspace_mode === 'team') {
    const server = config.team?.server_url;
    if (server) {
      try {
        const { createTeamAuthClient } = await import('@/lib/auth-client');
        const session = await createTeamAuthClient(server).getSession();
        const token = session.data?.session.token;
        if (version !== teamModelSessionVersion())
          throw new Error('Team authentication changed.');
        if (token) await syncTeamModelSession(server, token);
      } catch (error) {
        if (version !== teamModelSessionVersion()) throw error;
        // Native catalog lookup still supplies direct providers when Server
        // authentication or its model gateway is temporarily unavailable.
      }
    }
  }
  const boundVersion = teamModelSessionVersion();
  const models = status
    ? await invoke<ModelCatalogStatus>('model_catalog_status', { refresh })
    : await invoke<ModelDefinition[]>('model_catalog_list');
  if (
    config.workspace_mode === 'team' &&
    boundVersion !== teamModelSessionVersion()
  ) {
    throw new Error('Team authentication changed.');
  }
  return models;
}

export async function getSystemTheme() {
  return invoke<AppBaseTheme>('get_system_theme');
}

export async function restartApp() {
  return invoke<void>('restart_app');
}
