import { check, type Update } from '@tauri-apps/plugin-updater';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpdaterStore } from '@/stores/updater.store';

import { checkForStartupUpdate } from './updater';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));

describe('startup update checks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useUpdaterStore.setState({ open: false, update: null });
  });

  it('skips the check when automatic updates are disabled', async () => {
    await checkForStartupUpdate({ auto_check_update: false });
    expect(check).not.toHaveBeenCalled();
  });

  it('stores the available update without opening the dialog when enabled', async () => {
    const update = { version: '1.0.0' } as Update;
    vi.mocked(check).mockResolvedValue(update);

    await checkForStartupUpdate({ auto_check_update: true });

    expect(check).toHaveBeenCalledTimes(1);
    expect(useUpdaterStore.getState()).toMatchObject({ open: false, update });
  });

  it('defaults to enabled for older configurations and stays quiet without an update', async () => {
    vi.mocked(check).mockResolvedValue(null);

    await checkForStartupUpdate({});

    expect(check).toHaveBeenCalledTimes(1);
    expect(useUpdaterStore.getState()).toMatchObject({
      open: false,
      update: null,
    });
  });

  it('does not interrupt startup when checking fails', async () => {
    vi.mocked(check).mockRejectedValue(new Error('offline'));

    await expect(
      checkForStartupUpdate({ auto_check_update: true }),
    ).resolves.toBeUndefined();
    expect(useUpdaterStore.getState()).toMatchObject({
      open: false,
      update: null,
    });
  });
});
