import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';

export async function getAppVersion() {
  return await getVersion();
}

/**
 * @description Get an instance of `Webview` for the current webview window.
 *
 * @since tauri 2.0.0
 */
export function getCurrent() {
  return getCurrentWebviewWindow();
}

/**
 * @description Closes the webview.
 * @return {Promise<void>} A promise indicating the success or failure of the operation.
 */
export function windowClose() {
  return getCurrent().close();
}

/**
 * @description Minimizes the window.
 *
 * @returns {Promise<void>} A promise indicating the success or failure of the operation.
 */
export function windowMinimize() {
  return getCurrent().minimize();
}

export function setWindowFocus() {
  return getCurrent().setFocus();
}

/**
 * @description Gets the window's current theme.
 *
 * #### Platform-specific
 *
 * - **macOS:** Theme was introduced on macOS 10.14. Returns `light` on macOS 10.13 and below.
 *
 * @returns {Promise<AppBaseTheme | null>} The window theme: `light` or `dark`.
 */
export async function getWebviewWindowTheme() {
  return getCurrent().theme() as Promise<AppBaseTheme | null>;
}

export async function setWebviewWindowTheme(theme: AppBaseTheme | null) {
  await getCurrent().setTheme(theme);
}

export async function setBadgeCount(count: number) {
  if (OS_PLATFORM === 'win32') return;

  await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
}
