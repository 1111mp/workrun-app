import { Toaster, TooltipProvider } from '@workspace/ui/components';
import { RouterProvider } from 'react-router';

import { ConfirmProvider } from '@/components/confirm-dialog';
import { PythonUiRequestDialog } from '@/components/python-ui-request-dialog';
import { RunWorkspace } from '@/components/run-workspace';
import { TeamAuthTauriHandler } from '@/components/team-auth-tauri-handler';
import { UpdateDialog } from '@/components/update-dialog';
import { useTheme } from '@/hooks';
import { OnboardingPage } from '@/pages/onboarding';
import { router } from '@/routes';
import { useWorkrunStore } from '@/stores';

function App() {
  const config = useWorkrunStore((s) => s.config);
  const account = useWorkrunStore((s) => s.teamUser?.id);
  const scope = JSON.stringify([
    config?.workspace_mode,
    config?.team?.server_url,
    account,
  ]);

  useTheme();

  if (!config?.onboarding_completed) {
    return <OnboardingPage />;
  }

  return (
    <>
      <TooltipProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </TooltipProvider>
      <Toaster id='global' position='top-center' richColors={true} />
      <UpdateDialog />
      {config.workspace_mode === 'team' && config.team?.server_url ? (
        <TeamAuthTauriHandler />
      ) : null}
      <PythonUiRequestDialog key={`python:${scope}`} />
      <RunWorkspace key={`runs:${scope}`} />
    </>
  );
}

export default App;
