import { setWebviewWindowTheme } from '@/services/api';
import { getSystemTheme } from '@/services/cmd';

export function applyTheme(theme: AppBaseTheme, useViewTrans: boolean = true) {
  const root = window.document.documentElement;

  if (root.classList.contains(theme)) return;

  if ('startViewTransition' in document && useViewTrans) {
    document.startViewTransition(() => {
      root.classList.remove('light', 'dark');
      root.classList.add(theme);
      root.style.colorScheme = theme;
    });
  } else {
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    root.style.colorScheme = theme;
  }
}

export async function applyPendingTheme(payload: AppTheme) {
  const theme = payload === 'system' ? await getSystemTheme() : payload;
  applyTheme(theme);
  await setWebviewWindowTheme(payload === 'system' ? null : theme);
}
