import { invoke } from '@tauri-apps/api/core';

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

export async function getSystemTheme() {
  return invoke<AppBaseTheme>('get_system_theme');
}
