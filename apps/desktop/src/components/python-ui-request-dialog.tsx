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
import { useEffect, useState } from 'react';

const validator = customizeValidator({ extenderFn: ajvErrors });

import {
  onPythonUiRequest,
  respondToPythonUiRequest,
  type PythonUiRequestEvent,
} from '@/services/python-ipc';

/** Renders an IPC interaction using the same JSON Schema and uiSchema contract as RJSF. */
function PythonUiRequestDialog() {
  const [request, setRequest] = useState<PythonUiRequestEvent | null>(null);
  const [responding, setResponding] = useState(false);
  const [liveValidationRequestId, setLiveValidationRequestId] = useState<
    string | null
  >(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPythonUiRequest((request) => {
      setRequest(request);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => unlisten?.();
  }, []);

  const respond = async (data: unknown) => {
    if (!request || responding) return;
    setResponding(true);
    try {
      await respondToPythonUiRequest(request, data);
      setRequest(null);
    } finally {
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
