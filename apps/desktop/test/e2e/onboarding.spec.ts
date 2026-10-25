import { browser, expect } from '@wdio/globals';

describe('Personal onboarding', () => {
  it('saves the profile through real IPC and restores it after reload', async () => {
    await browser.waitUntil(
      async () => {
        try {
          const runs = await browser.tauri.execute(({ core }) =>
            core.invoke('run_history_list_active'),
          );
          return Array.isArray(runs);
        } catch {
          return false;
        }
      },
      { timeoutMsg: 'The Rust database did not finish initializing' },
    );
    await expect(browser.$('h1')).toHaveText('Choose how you want to work');
    await browser.$('button=Use this device').click();
    await expect(browser.$('h1')).toHaveText('Set up your local profile');
    await browser.$('button=Start using Workrun').click();
    await expect(browser.$('#display-name')).toBeDisplayed();
    await browser.$('#display-name').setValue('E2E User');
    await browser.$('button=Start using Workrun').click();

    await browser.waitUntil(
      async () => {
        const config = await browser.tauri.execute(
          ({ core }) =>
            core.invoke('get_workrun_config') as Promise<IWorkrunConfig>,
        );
        return config.onboarding_completed === true;
      },
      { timeoutMsg: 'Onboarding was not persisted by the Rust backend' },
    );
    await browser.refresh();
    await expect(browser.$('#display-name')).not.toExist();
    await expect(
      browser.$('a[data-sidebar="menu-button"][href="/workflows"]'),
    ).toBeDisplayed();
    const config = await browser.tauri.execute(
      ({ core }) =>
        core.invoke('get_workrun_config') as Promise<IWorkrunConfig>,
    );
    expect(config).toMatchObject({
      workspace_mode: 'personal',
      onboarding_completed: true,
      local_profile: { display_name: 'E2E User' },
    });
  });
});
