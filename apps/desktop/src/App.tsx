import { Toaster, TooltipProvider } from '@workspace/ui/components';
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router';

import { UpdateDialog } from '@/components';
import { PythonConfirmDialog } from '@/components/python-confirm-dialog';
import { useTheme } from '@/hooks';
import { router } from '@/routes';
import {
  onPythonUiRequest,
  type PythonUiRequestEvent,
} from '@/services/python-ipc';

function App() {
  useTheme();
  const [pythonUiRequest, setPythonUiRequest] =
    useState<PythonUiRequestEvent | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPythonUiRequest((request) => {
      setPythonUiRequest(request);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => unlisten?.();
  }, []);

  return (
    <>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
      <Toaster id='global' position='top-center' richColors={true} />
      <UpdateDialog />
      <PythonConfirmDialog
        request={pythonUiRequest}
        onResolved={() => setPythonUiRequest(null)}
      />
    </>
  );
}

export default App;
