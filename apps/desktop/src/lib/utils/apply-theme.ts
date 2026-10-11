import { setWebviewWindowTheme } from '@/services/api';
import { getSystemTheme } from '@/services/cmd';

let pendingTheme: AppBaseTheme | undefined;

export function applyTheme(theme: AppBaseTheme, useViewTrans: boolean = true) {
  const root = window.document.documentElement;

  if (
    pendingTheme === theme ||
    (!pendingTheme && root.classList.contains(theme))
  )
    return;

  pendingTheme = theme;
  const updateTheme = () => {
    // A skipped transition still runs its callback. An older request must not
    // overwrite the latest selection, including a switch back before painting.
    if (pendingTheme !== theme) return;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.style.colorScheme = theme;
    pendingTheme = undefined;
  };

  if ('startViewTransition' in document && useViewTrans) {
    const transition = document.startViewTransition(updateTheme);
    // Rapid switches or navigation can abort the animation; the DOM update
    // still completes. Handle ready's rejection without treating it as a theme failure.
    void transition.ready.catch(() => undefined);
  } else {
    updateTheme();
  }
}

export async function applyPendingTheme(payload: AppTheme) {
  const theme = payload === 'system' ? await getSystemTheme() : payload;
  applyTheme(theme);
  await setWebviewWindowTheme(payload === 'system' ? null : theme);
}
