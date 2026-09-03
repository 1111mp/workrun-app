import {
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@workspace/ui/components';
import { PlusIcon, Trash2Icon } from 'lucide-react';

type WorkflowSettingsPanelProps = {
  open: boolean;
  settings: WorkflowSettings;
  executableNodes: { id: string; name: string }[];
  onOpenChange: (open: boolean) => void;
  onSettingsChange: (patch: Partial<WorkflowSettings>) => void;
};

const inputTypeLabels = [
  {
    label: 'Short text',
    value: 'string',
  },
  {
    label: 'Long text',
    value: 'textarea',
  },
  {
    label: 'Number',
    value: 'number',
  },
  {
    label: 'Yes / no',
    value: 'boolean',
  },
];

function WorkflowSettingsPanel({
  open,
  settings,
  executableNodes,
  onOpenChange,
  onSettingsChange,
}: WorkflowSettingsPanelProps) {
  const updateInput = (inputId: string, patch: Partial<WorkflowInput>) => {
    const current = settings.inputSchema.fields.find(
      (input) => input.id === inputId,
    );
    const sensitiveFields = settings.inputSchema.sensitiveFields ?? [];
    onSettingsChange({
      inputSchema: {
        ...settings.inputSchema,
        fields: settings.inputSchema.fields.map((input) =>
          input.id === inputId ? { ...input, ...patch } : input,
        ),
        sensitiveFields:
          current && patch.key && sensitiveFields.includes(current.key)
            ? sensitiveFields.map((key) =>
                key === current.key ? patch.key! : key,
              )
            : sensitiveFields,
      },
    });
  };

  const setInputSensitive = (key: string, sensitive: boolean) => {
    const fields = new Set(settings.inputSchema.sensitiveFields ?? []);
    if (sensitive) fields.add(key);
    else fields.delete(key);
    onSettingsChange({
      inputSchema: {
        ...settings.inputSchema,
        sensitiveFields: [...fields],
      },
    });
  };

  const setInputRawReader = (nodeId: string, allowed: boolean) => {
    const readers = new Set(settings.inputSchema.rawReaders ?? []);
    if (allowed) readers.add(nodeId);
    else readers.delete(nodeId);
    onSettingsChange({
      inputSchema: { ...settings.inputSchema, rawReaders: [...readers] },
    });
  };

  const addInput = () => {
    const index = settings.inputSchema.fields.length + 1;
    onSettingsChange({
      inputSchema: {
        ...settings.inputSchema,
        fields: [
          ...settings.inputSchema.fields,
          {
            id: crypto.randomUUID(),
            key: `input_${index}`,
            label: `Input ${index}`,
            type: 'string',
            required: false,
          },
        ],
      },
    });
  };

  const removeInput = (inputId: string) => {
    const removedKey = settings.inputSchema.fields.find(
      (input) => input.id === inputId,
    )?.key;
    onSettingsChange({
      inputSchema: {
        ...settings.inputSchema,
        fields: settings.inputSchema.fields.filter(
          (input) => input.id !== inputId,
        ),
        sensitiveFields: (settings.inputSchema.sensitiveFields ?? []).filter(
          (key) => key !== removedKey,
        ),
      },
    });
  };

  const outputFields = settings.outputSchema?.fields ?? [];
  const updateOutput = (outputId: string, patch: Partial<WorkflowInput>) =>
    onSettingsChange({
      outputSchema: {
        fields: outputFields.map((output) =>
          output.id === outputId ? { ...output, ...patch } : output,
        ),
      },
    });
  const addOutput = () => {
    const index = outputFields.length + 1;
    onSettingsChange({
      outputSchema: {
        fields: [
          ...outputFields,
          {
            id: crypto.randomUUID(),
            key: `output_${index}`,
            label: `Output ${index}`,
            type: 'string',
            required: false,
          },
        ],
      },
    });
  };
  const removeOutput = (outputId: string) =>
    onSettingsChange({
      outputSchema: {
        fields: outputFields.filter((output) => output.id !== outputId),
      },
    });

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      swipeDirection='right'
      horizontalSnapPoints={['31rem', '48rem', '64rem']}
    >
      <DrawerContent className='gap-0 sm:[--drawer-content-width:36rem]'>
        <DrawerHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/10 to-violet-500/8 p-5 pr-14'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[16px_16px]' />
          <DrawerTitle className='relative text-lg'>More settings</DrawerTitle>
          <DrawerDescription className='relative mt-1 leading-5'>
            Define a description and the parameters each run accepts.
          </DrawerDescription>
        </DrawerHeader>
        <div className='min-h-0 flex-1 overflow-y-auto px-5 py-6'>
          <FieldGroup className='gap-7'>
            <FieldSet className='bg-card gap-4 rounded-xl border p-4 shadow-xs'>
              <FieldLegend>Workflow details</FieldLegend>
              <FieldLabel htmlFor='workflow-description'>
                Description
              </FieldLabel>
              <FieldDescription>
                Explain the outcome this workflow produces.
              </FieldDescription>
              <Textarea
                id='workflow-description'
                value={settings.description}
                onChange={(event) =>
                  onSettingsChange({ description: event.target.value })
                }
              />
            </FieldSet>
            <FieldSet className='bg-muted/20 gap-4 rounded-xl border p-4'>
              <div className='flex items-center justify-between gap-2'>
                <FieldLegend>Run inputs</FieldLegend>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={addInput}
                >
                  <PlusIcon data-icon='inline-start' />
                  Add input
                </Button>
              </div>
              <FieldDescription>
                These define the values a task run can receive. Actual values
                belong to an individual run and are not saved in the workflow.
                Chat workflows also receive these values alongside their
                message; the <code>input</code> key is reserved for that
                message.
              </FieldDescription>
              <FieldGroup className='gap-5'>
                {settings.inputSchema.fields.map((input) => (
                  <FieldSet
                    key={input.id}
                    className='bg-background gap-5 rounded-xl border p-4 shadow-xs'
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <FieldLegend variant='label'>
                        {input.label || 'Untitled input'}
                      </FieldLegend>
                      <Button
                        type='button'
                        size='icon-sm'
                        variant='ghost'
                        aria-label={`Remove ${input.label || 'input'}`}
                        onClick={() => removeInput(input.id)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <FieldGroup className='gap-4'>
                      <FieldGroup className='grid gap-4 sm:grid-cols-2'>
                        <Field>
                          <FieldLabel
                            htmlFor={`workflow-input-label-${input.id}`}
                          >
                            Label
                          </FieldLabel>
                          <Input
                            id={`workflow-input-label-${input.id}`}
                            value={input.label}
                            onChange={(event) =>
                              updateInput(input.id, {
                                label: event.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel
                            htmlFor={`workflow-input-key-${input.id}`}
                          >
                            Key
                          </FieldLabel>
                          <Input
                            id={`workflow-input-key-${input.id}`}
                            value={input.key}
                            onChange={(event) =>
                              updateInput(input.id, { key: event.target.value })
                            }
                          />
                        </Field>
                      </FieldGroup>
                      <Field>
                        <FieldLabel htmlFor={`workflow-input-type-${input.id}`}>
                          Type
                        </FieldLabel>
                        <Select
                          items={inputTypeLabels}
                          value={input.type}
                          onValueChange={(type) =>
                            updateInput(input.id, {
                              type: type as WorkflowInputType,
                            })
                          }
                        >
                          <SelectTrigger
                            id={`workflow-input-type-${input.id}`}
                            className='w-full'
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {inputTypeLabels.map(({ value, label }) => (
                                <SelectItem key={value} value={value}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field>
                        <FieldLabel
                          htmlFor={`workflow-input-description-${input.id}`}
                        >
                          Help text
                        </FieldLabel>
                        <Textarea
                          id={`workflow-input-description-${input.id}`}
                          value={input.description ?? ''}
                          onChange={(event) =>
                            updateInput(input.id, {
                              description: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field
                        orientation='horizontal'
                        className='bg-muted/20 rounded-lg border p-3'
                      >
                        <Switch
                          id={`workflow-input-required-${input.id}`}
                          checked={input.required}
                          onCheckedChange={(required) =>
                            updateInput(input.id, { required })
                          }
                        />
                        <FieldContent>
                          <FieldLabel
                            htmlFor={`workflow-input-required-${input.id}`}
                          >
                            Required
                          </FieldLabel>
                          <FieldDescription>
                            A run cannot start without this value.
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                      <Field
                        orientation='horizontal'
                        className='bg-muted/20 rounded-lg border p-3'
                      >
                        <FieldContent>
                          <FieldLabel>Sensitive value</FieldLabel>
                          <FieldDescription>
                            Always replace this input in visible State.
                          </FieldDescription>
                        </FieldContent>
                        <Switch
                          checked={(
                            settings.inputSchema.sensitiveFields ?? []
                          ).includes(input.key)}
                          onCheckedChange={(checked) =>
                            setInputSensitive(input.key, checked)
                          }
                        />
                      </Field>
                    </FieldGroup>
                  </FieldSet>
                ))}
              </FieldGroup>
              {executableNodes.length > 0 ? (
                <FieldGroup className='gap-3 border-t pt-4'>
                  <FieldLegend variant='label'>Raw input readers</FieldLegend>
                  <FieldDescription>
                    Ordinary nodes and Agent tools selected here may use the
                    original run inputs. Agent prompts remain redacted.
                  </FieldDescription>
                  {executableNodes.map((node) => (
                    <Field
                      key={node.id}
                      orientation='horizontal'
                      className='bg-background rounded-lg border p-3'
                    >
                      <FieldLabel>{node.name}</FieldLabel>
                      <Switch
                        checked={(
                          settings.inputSchema.rawReaders ?? []
                        ).includes(node.id)}
                        onCheckedChange={(checked) =>
                          setInputRawReader(node.id, checked)
                        }
                      />
                    </Field>
                  ))}
                </FieldGroup>
              ) : null}
            </FieldSet>
            <FieldSet className='bg-muted/20 gap-4 rounded-xl border p-4'>
              <div className='flex items-center justify-between gap-2'>
                <FieldLegend>Workflow outputs</FieldLegend>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={addOutput}
                >
                  <PlusIcon data-icon='inline-start' />
                  Add output
                </Button>
              </div>
              <FieldDescription>
                Declare the global State keys this workflow exposes when used as
                a subworkflow. The node producing each value must publish that
                key to Global State.
              </FieldDescription>
              <FieldGroup className='gap-4'>
                {outputFields.map((output) => (
                  <FieldSet
                    key={output.id}
                    className='bg-background gap-4 rounded-xl border p-4 shadow-xs'
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <FieldLegend variant='label'>
                        {output.label || 'Untitled output'}
                      </FieldLegend>
                      <Button
                        type='button'
                        size='icon-sm'
                        variant='ghost'
                        aria-label={`Remove ${output.label || 'output'}`}
                        onClick={() => removeOutput(output.id)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <FieldGroup className='grid gap-4 sm:grid-cols-2'>
                      <Field>
                        <FieldLabel
                          htmlFor={`workflow-output-label-${output.id}`}
                        >
                          Label
                        </FieldLabel>
                        <Input
                          id={`workflow-output-label-${output.id}`}
                          value={output.label}
                          onChange={(event) =>
                            updateOutput(output.id, {
                              label: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel
                          htmlFor={`workflow-output-key-${output.id}`}
                        >
                          State key
                        </FieldLabel>
                        <Input
                          id={`workflow-output-key-${output.id}`}
                          value={output.key}
                          onChange={(event) =>
                            updateOutput(output.id, { key: event.target.value })
                          }
                        />
                      </Field>
                    </FieldGroup>
                  </FieldSet>
                ))}
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export { WorkflowSettingsPanel };
