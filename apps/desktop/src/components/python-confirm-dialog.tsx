import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Spinner,
} from '@workspace/ui/components';
import { useState } from 'react';

import {
  respondToPythonConfirm,
  type PythonUiRequestEvent,
} from '@/services/python-ipc';

type PythonConfirmDialogProps = {
  request: PythonUiRequestEvent | null;
  onResolved: () => void;
};

function PythonConfirmDialog({
  request,
  onResolved,
}: PythonConfirmDialogProps) {
  const [responding, setResponding] = useState(false);
  const confirmed = isConfirmRequest(request);

  const respond = async (accepted: boolean) => {
    if (!request || responding) return;
    setResponding(true);
    try {
      await respondToPythonConfirm(request, accepted);
      onResolved();
    } finally {
      setResponding(false);
    }
  };

  if (!request || !confirmed) return null;

  return (
    <AlertDialog open={true}>
      <AlertDialogContent size='sm'>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title ?? 'Confirm'}</AlertDialogTitle>
          {request.description ? (
            <AlertDialogDescription>
              {request.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={responding}
            onClick={() => void respond(false)}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={responding}
            onClick={() => void respond(true)}
          >
            {responding ? <Spinner data-icon='inline-start' /> : null}
            {confirmed.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function isConfirmRequest(
  request: PythonUiRequestEvent | null,
): { confirmLabel: string } | null {
  if (!request || typeof request.schema !== 'object' || request.schema === null)
    return null;
  const properties = (request.schema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return null;
  const confirmed = (properties as Record<string, unknown>).confirmed;
  if (typeof confirmed !== 'object' || confirmed === null) return null;
  if ((confirmed as { type?: unknown }).type !== 'boolean') return null;
  const title = (confirmed as { title?: unknown }).title;
  return {
    confirmLabel: typeof title === 'string' && title ? title : 'Confirm',
  };
}

export { isConfirmRequest, PythonConfirmDialog };
