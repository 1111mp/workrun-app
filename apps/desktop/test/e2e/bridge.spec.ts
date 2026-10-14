import { browser, expect } from '@wdio/globals';

describe('Desktop test bridge', () => {
  it('mocks an IPC command through the service and restores it', async () => {
    const mock = await browser.tauri.mock('e2e_bridge_probe');
    try {
      await mock.mockReturnValue({ status: 'ready' });
      const result = await browser.tauri.execute(({ core }) =>
        core.invoke('e2e_bridge_probe', { id: 'probe-1' }),
      );
      expect(result).toEqual({ status: 'ready' });
    } finally {
      await mock.mockRestore();
    }
    // This command has no Rust handler; rejection proves the mock was removed.
    await expect(
      browser.tauri.execute(({ core }) => core.invoke('e2e_bridge_probe')),
    ).rejects.toBeDefined();
  });

  it('captures a PNG screenshot from the native webview', async () => {
    const screenshot = await browser.takeScreenshot();
    expect(Buffer.from(screenshot, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });
});
