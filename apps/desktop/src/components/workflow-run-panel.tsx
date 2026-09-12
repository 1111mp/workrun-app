import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Spinner,
  Switch,
  Textarea,
} from '@workspace/ui/components';
import type { Node } from '@xyflow/react';
import { PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { WorkflowRunOutput } from '@/components/workflow-output-panel';
import { useWorkflowRunStore } from '@/stores';

type RunValues = Record<string, string | boolean>;

type WorkflowRunPanelProps = {
  settings: WorkflowSettings;
  nodes: Node[];
  onRun: (initialState: Record<string, unknown>) => void;
  onResume: () => void;
  onRetryFailed: () => void;
  readOnly?: boolean;
  onHistoricalClose?: () => void;
};

const chatMessageInput: WorkflowInput = {
  id: 'chat-message',
  key: 'input',
  label: 'Message',
  type: 'textarea',
  required: true,
  description: 'Send a message to start this workflow.',
};

function runInputs(settings: WorkflowSettings): WorkflowInput[] {
  if (settings.mode === 'task') {
    return settings.inputSchema.fields;
  }

  return [
    chatMessageInput,
    ...settings.inputSchema.fields.filter((input) => input.key !== 'input'),
  ];
}

function initialValues(settings: WorkflowSettings): RunValues {
  return Object.fromEntries(
    runInputs(settings).map(
      (input) => [input.key, input.type === 'boolean' ? false : ''] as const,
    ),
  );
}

type WorkflowRunFormProps = {
  settings: WorkflowSettings;
  isRunning: boolean;
  onClose: () => void;
  onRun: (initialState: Record<string, unknown>) => void;
};

function WorkflowRunForm({
  settings,
  isRunning,
  onClose,
  onRun,
}: WorkflowRunFormProps) {
  const { t } = useTranslation();
  const inputs = runInputs(settings);
  const [values, setValues] = useState<RunValues>(() =>
    initialValues(settings),
  );
  const [errors, setErrors] = useState<Set<string>>(new Set());

  const submit = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const missing = new Set(
      inputs.flatMap((input) =>
        input.required &&
        input.type !== 'boolean' &&
        !String(values[input.key] ?? '').trim()
          ? [input.key]
          : [],
      ),
    );
    if (missing.size > 0) {
      setErrors(missing);
      return;
    }

    const state = Object.fromEntries(
      inputs.flatMap((input) => {
        const value = values[input.key];
        if (input.type === 'boolean') return [[input.key, value === true]];
        if (value === undefined || value === '') return [];
        return [[input.key, input.type === 'number' ? Number(value) : value]];
      }),
    );
    onRun(state);
  };

  return (
    <form className='flex min-h-0 flex-1 flex-col' onSubmit={submit}>
      <div className='min-h-0 flex-1 overflow-y-auto px-4 py-4'>
        <FieldGroup>
          {inputs.map((input) => {
            const invalid = errors.has(input.key);
            const value = values[input.key];
            return (
              <Field key={input.id} data-invalid={invalid || undefined}>
                <FieldLabel htmlFor={`run-input-${input.id}`}>
                  {input.label}
                </FieldLabel>
                {input.description && (
                  <FieldDescription>{input.description}</FieldDescription>
                )}
                {input.type === 'textarea' ? (
                  <Textarea
                    id={`run-input-${input.id}`}
                    aria-invalid={invalid || undefined}
                    required={input.required}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [input.key]: event.target.value,
                      }))
                    }
                  />
                ) : input.type === 'boolean' ? (
                  <Field orientation='horizontal'>
                    <Switch
                      id={`run-input-${input.id}`}
                      checked={value === true}
                      onCheckedChange={(checked) =>
                        setValues((current) => ({
                          ...current,
                          [input.key]: checked,
                        }))
                      }
                    />
                    <FieldContent>
                      <FieldDescription>
                        {t('workflowEditor.enabled')}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                ) : (
                  <Input
                    id={`run-input-${input.id}`}
                    type={input.type === 'number' ? 'number' : 'text'}
                    aria-invalid={invalid || undefined}
                    required={input.required}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [input.key]: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
            );
          })}
        </FieldGroup>
      </div>
      <DrawerFooter>
        <Button type='button' variant='outline' onClick={onClose}>
          {t('apps.new.cancel')}
        </Button>
        <Button type='submit' disabled={isRunning}>
          {isRunning ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <PlayIcon data-icon='inline-start' />
          )}
          {t('workflows.run')}
        </Button>
      </DrawerFooter>
    </form>
  );
}

function WorkflowRunPanel({
  settings,
  nodes,
  onRun,
  onResume,
  onRetryFailed,
  readOnly = false,
  onHistoricalClose,
}: WorkflowRunPanelProps) {
  const { t } = useTranslation();
  const {
    lastRunInput,
    open,
    run,
    showOutput,
    setRunPanelOpen: onOpenChange,
  } = useWorkflowRunStore(
    useShallow((state) => ({
      lastRunInput: state.lastRunInput,
      open: state.runPanelOpen,
      run: state.runView,
      showOutput: state.showRunOutput,
      setRunPanelOpen: state.setRunPanelOpen,
    })),
  );

  const isRunning = run.status === 'running';
  const [retryConfirmationOpen, setRetryConfirmationOpen] = useState(false);
  const formKey = `${open}:${JSON.stringify(settings)}`;
  const runAgain = () => {
    if (run.status === 'interrupted') {
      onResume();
      return;
    }
    if (run.status === 'failed') {
      setRetryConfirmationOpen(true);
      return;
    }
    if (lastRunInput) onRun(lastRunInput);
  };

  return (
    <>
      <Drawer
      open={open}
      defaultHorizontalSnapPoint='31rem'
      horizontalSnapPoints={['31rem', '48rem', '64rem', '86rem']}
      swipeDirection='right'
      onOpenChange={(open) => {
        if (!open && readOnly) onHistoricalClose?.();
        else onOpenChange(open);
      }}
    >
      <DrawerContent>
        {settings.mode === 'chat' ? (
          <WorkflowRunOutput
            run={run}
            workflowNodes={nodes}
            isRunning={isRunning}
            isChat
            readOnly={readOnly}
            onRunAgain={runAgain}
            onSend={onRun}
            onClose={() =>
              readOnly ? onHistoricalClose?.() : onOpenChange(false)
            }
          />
        ) : showOutput ? (
          <WorkflowRunOutput
            run={run}
            workflowNodes={nodes}
            isRunning={isRunning}
            readOnly={readOnly}
            onRunAgain={runAgain}
            onClose={() =>
              readOnly ? onHistoricalClose?.() : onOpenChange(false)
            }
          />
        ) : (
          <>
            <DrawerHeader>
              <DrawerTitle>{t('workflowEditor.testRun')}</DrawerTitle>
              <DrawerDescription>
                {t('workflowEditor.testRunDescription')}
              </DrawerDescription>
            </DrawerHeader>
            <WorkflowRunForm
              key={formKey}
              settings={settings}
              isRunning={isRunning}
              onClose={() => onOpenChange(false)}
              onRun={onRun}
            />
          </>
        )}
      </DrawerContent>
      </Drawer>
      <AlertDialog open={retryConfirmationOpen} onOpenChange={setRetryConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry from checkpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              Earlier completed nodes will not run again. The failed node may have already performed an external action, such as sending a message or updating a record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRetryConfirmationOpen(false);
                onRetryFailed();
              }}
            >
              Retry failed node
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export { WorkflowRunPanel };
