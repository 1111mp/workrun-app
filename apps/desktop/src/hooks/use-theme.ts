import { useEffect } from 'react';

import { applyTheme } from '@/lib/utils';
import { getCurrent } from '@/services/api';
import { useWorkrunStore } from '@/stores';

export function useTheme() {
  const theme = useWorkrunStore((s) => s.config?.theme);
  const setResolvedTheme = useWorkrunStore((s) => s.setResolvedTheme);

  useEffect(() => {
    if (!theme) return;

    if (theme !== 'system') {
      setResolvedTheme(theme);
      return;
    }

    const unlisten = listenSystemTheme((theme) => {
      applyTheme(theme);
      setResolvedTheme(theme);
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [setResolvedTheme, theme]);
}

function listenSystemTheme(callback: (theme: AppBaseTheme) => void) {
  return getCurrent().onThemeChanged((e) => {
    callback(e.payload as AppBaseTheme);
  });
}
