import { Toaster, TooltipProvider } from '@workspace/ui/components';
import { useEffect } from 'react';
import { RouterProvider } from 'react-router';

import { UpdateDialog } from '@/components';
import { useTheme } from '@/hooks';
import { router } from '@/routes';
import { onPythonUiRequest } from '@/services/python-ipc';

function App() {
  useTheme();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPythonUiRequest((request) => {
      console.info('Received Python UI request:', request);
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
    </>
  );
}

export default App;
