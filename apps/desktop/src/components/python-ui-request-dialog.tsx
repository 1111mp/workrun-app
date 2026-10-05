import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { customizeValidator } from '@rjsf/validator-ajv8';
import { open } from '@tauri-apps/plugin-dialog';
import Form from '@workspace/json-schema-form';
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
import ajvErrors from 'ajv-errors';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const validator = customizeValidator({ extenderFn: ajvErrors });

import {
  onPythonUiRequest,
  onPythonIpcSessionClosed,
  respondToPythonUiRequest,
  type PythonUiRequestEvent,
} from '@/services/python-ipc';

/** Renders an IPC interaction using the same JSON Schema and uiSchema contract as RJSF. */
function PythonUiRequestDialog() {
  const [requests, setRequests] = useState<PythonUiRequestEvent[]>([]);
  const request = requests[0];
  const responseInFlight = useRef(false);
  const closedSessions = useRef(new Set<string>());
  const [responding, setResponding] = useState(false);
  const [liveValidationRequestId, setLiveValidationRequestId] = useState<
    string | null
  >(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;
    void onPythonUiRequest((request) => {
      if (disposed || closedSessions.current.has(request.runId)) return;
      setRequests((current) =>
        current.some(
          (item) =>
            item.runId === request.runId &&
            item.requestId === request.requestId,
        )
          ? current
          : [...current, request],
      );
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    void onPythonIpcSessionClosed((sessionId) => {
      closedSessions.current.add(sessionId);
      if (!disposed)
        setRequests((current) =>
          current.filter((item) => item.runId !== sessionId),
        );
    }).then((dispose) => {
      if (disposed) dispose();
      else unlistenClosed = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenClosed?.();
    };
  }, []);

  const respond = async (data: unknown) => {
    if (!request || responseInFlight.current) return;
    responseInFlight.current = true;
    setResponding(true);
    // A submitted collect() call can immediately issue a follow-up confirm().
    // Clear only the request being answered before the IPC round trip, so the
    // new prompt cannot be erased by this older async handler.
    setRequests((current) =>
      current.filter(
        (item) =>
          item.runId !== request.runId || item.requestId !== request.requestId,
      ),
    );
    try {
      await respondToPythonUiRequest(request, data);
    } catch (error) {
      if (!closedSessions.current.has(request.runId)) {
        setRequests((current) => [request, ...current]);
      }
      toast.error('Could not submit the form', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      responseInFlight.current = false;
      setResponding(false);
    }
  };

  if (!request || !isSchema(request.schema)) return null;

  const formId = `python-ui-request-${request.requestId}`;
  const shouldLiveValidate = liveValidationRequestId === request.requestId;

  return (
    <AlertDialog open={true}>
      <AlertDialogContent className='max-w-lg!'>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {request.title ?? 'Input required'}
          </AlertDialogTitle>
          {request.description ? (
            <AlertDialogDescription>
              {request.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <Form
          id={formId}
          noHtml5Validate
          key={request.requestId}
          liveValidate={shouldLiveValidate ? 'onChange' : false}
          schema={request.schema}
          uiSchema={
            isSchema(request.uiSchema) ? (request.uiSchema as UiSchema) : {}
          }
          validator={validator}
          formContext={{
            selectPath: async ({ directory }: { directory: boolean }) => {
              const path = await open({ directory, multiple: false });
              return typeof path === 'string' ? path : null;
            },
          }}
          disabled={responding}
          showErrorList={false}
          onError={() => setLiveValidationRequestId(request.requestId)}
          onSubmit={({ formData }) => void respond(formData ?? {})}
        >
          <></>
        </Form>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={responding}
            onClick={() => void respond(null)}
          >
            {request.cancelLabel ?? 'Cancel'}
          </AlertDialogCancel>
          <AlertDialogAction disabled={responding} form={formId} type='submit'>
            {responding ? <Spinner data-icon='inline-start' /> : null}
            {request.submitLabel ?? 'Submit'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function isSchema(value: unknown): value is RJSFSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { PythonUiRequestDialog };
