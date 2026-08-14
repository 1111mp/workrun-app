import '@/lib/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReactDOM from 'react-dom/client';

import './styles/global.css';

import App from '@/app';
import { applyTheme } from '@/lib/utils';
import { getAppInitialData } from '@/services/init';

void (async () => {
  const [config, sysTheme] = await getAppInitialData();
  // Set the theme in advance to prevent flickering.
  applyTheme(config.theme !== 'system' ? config.theme : sysTheme, false);

  const queryClient = new QueryClient();

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
})();
