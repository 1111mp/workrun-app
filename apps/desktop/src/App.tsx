import { Toaster, TooltipProvider } from '@workspace/ui/components';
import { RouterProvider } from 'react-router';

import { UpdateDialog } from '@/components';
import { useTheme } from '@/hooks';
import { router } from '@/routes';

function App() {
  useTheme();

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
