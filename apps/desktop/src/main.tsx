import '@/lib/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReactDOM from 'react-dom/client';

import './styles/global.css';

import App from '@/app';
import { applyTheme } from '@/lib/utils';
import { getAppInitialData } from '@/services/init';
import { checkForStartupUpdate } from '@/services/updater';

void (async () => {
  // The desktop test bridge is excluded from normal production builds.
  if (import.meta.env.MODE === 'e2e') {
    await import('@wdio/tauri-plugin');
  }

  const [config, sysTheme] = await getAppInitialData();
  // Set the theme in advance to prevent flickering.
  applyTheme(config.theme !== 'system' ? config.theme : sysTheme, false);

  const queryClient = new QueryClient();

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );

  void checkForStartupUpdate(config);
})();
