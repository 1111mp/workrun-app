import { Toaster, TooltipProvider } from '@workspace/ui/components';
import { RouterProvider } from 'react-router';

import { UpdateDialog } from '@/components';
import { ApprovalCoordinator } from '@/components/approval-coordinator';
import { PythonUiRequestDialog } from '@/components/python-ui-request-dialog';
import { RunWorkspace } from '@/components/run-workspace';
import { TeamAuthTauriHandler } from '@/components/team-auth-tauri-handler';
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
      <ApprovalCoordinator />
      <RunWorkspace />
    </>
  );
}

export default App;
