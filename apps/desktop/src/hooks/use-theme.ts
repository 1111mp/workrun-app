import { useEffect } from 'react';

import { applyTheme } from '@/lib/utils';
import { getCurrent } from '@/services/api';
import { useWorkrunStore } from '@/stores';

export function useTheme() {
  const theme = useWorkrunStore((s) => s.config?.theme);

  useEffect(() => {
    if (theme !== 'system') return;

    const unlisten = listenSystemTheme((theme) => {
      applyTheme(theme);
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [theme]);
}

function listenSystemTheme(callback: (theme: AppBaseTheme) => void) {
  return getCurrent().onThemeChanged((e) => {
    callback(e.payload as AppBaseTheme);
  });
}
