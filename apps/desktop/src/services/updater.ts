import { check } from '@tauri-apps/plugin-updater';

import { useUpdaterStore } from '@/stores/updater.store';

export async function checkForStartupUpdate(
  config: Pick<IWorkrunConfig, 'auto_check_update'>,
): Promise<void> {
  if (config.auto_check_update === false) return;

  try {
    const update = await check();
    if (update) {
      const updater = useUpdaterStore.getState();
      updater.setUpdate(update);
    }
  } catch {
    // Background checks must not interrupt startup when the network is unavailable.
  }
}
