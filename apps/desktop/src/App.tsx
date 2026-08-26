import { Toaster, TooltipProvider } from '@workspace/ui/components';
import { RouterProvider } from 'react-router';

import { UpdateDialog } from '@/components';
import { TeamAuthTauriHandler } from '@/components/team-auth-tauri-handler';
import { PythonUiRequestDialog } from '@/components/python-ui-request-dialog';
import { useTheme } from '@/hooks';
import { OnboardingPage } from '@/pages/onboarding';
import { router } from '@/routes';
import { useWorkrunStore } from '@/stores';

function App() {
  const config = useWorkrunStore((s) => s.config);

  useTheme();

  if (!config?.onboarding_completed) {
    return <OnboardingPage />;
  }

  return (
    <>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
      <TeamAuthTauriHandler />
      <Toaster id='global' position='top-center' richColors={true} />
      <UpdateDialog />
      <PythonUiRequestDialog />
    </>
  );
}

export default App;
