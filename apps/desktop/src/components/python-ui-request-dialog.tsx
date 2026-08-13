import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { customizeValidator } from '@rjsf/validator-ajv8';
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
import { useState } from 'react';

const validator = customizeValidator({ extenderFn: ajvErrors });

import {
  respondToPythonUiRequest,
  type PythonUiRequestEvent,
} from '@/services/python-ipc';

type PythonUiRequestDialogProps = {
  request: PythonUiRequestEvent | null;
  onResolved: () => void;
};

/** Renders an IPC interaction using the same JSON Schema and uiSchema contract as RJSF. */
function PythonUiRequestDialog({
  request,
  onResolved,
}: PythonUiRequestDialogProps) {
  const [responding, setResponding] = useState(false);
  const [liveValidationRequestId, setLiveValidationRequestId] = useState<
    string | null
  >(null);

  const respond = async (data: unknown) => {
    if (!request || responding) return;
    setResponding(true);
    try {
      await respondToPythonUiRequest(request, data);
      onResolved();
    } finally {
      setResponding(false);
    }
  };

  console.log('request', request);

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
