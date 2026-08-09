import {
  Button,
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
  Textarea,
} from '@workspace/ui/components';
import { PlusIcon, Trash2Icon } from 'lucide-react';

type WorkflowSettingsPanelProps = {
  open: boolean;
  settings: WorkflowSettings;
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
  onOpenChange,
  onSettingsChange,
}: WorkflowSettingsPanelProps) {
  const updateInput = (inputId: string, patch: Partial<WorkflowInput>) => {
    onSettingsChange({
      inputSchema: {
        fields: settings.inputSchema.fields.map((input) =>
          input.id === inputId ? { ...input, ...patch } : input,
        ),
      },
    });
  };

  const addInput = () => {
    const index = settings.inputSchema.fields.length + 1;
    onSettingsChange({
      inputSchema: {
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
    onSettingsChange({
      inputSchema: {
        fields: settings.inputSchema.fields.filter(
          (input) => input.id !== inputId,
        ),
      },
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='w-full gap-0 sm:max-w-md'>
        <SheetHeader>
          <SheetTitle>More settings</SheetTitle>
          <SheetDescription>
            Define a description and the parameters each run accepts.
          </SheetDescription>
        </SheetHeader>
        <div className='min-h-0 flex-1 overflow-y-auto px-4 py-4'>
          <FieldGroup>
            <Field>
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
            </Field>
            <FieldSet>
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
              <FieldGroup className='gap-4'>
                {settings.inputSchema.fields.map((input) => (
                  <FieldSet
                    key={input.id}
                    className='gap-4 rounded-lg border p-3'
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
                            updateInput(input.id, { label: event.target.value })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`workflow-input-key-${input.id}`}>
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
                      <Field orientation='horizontal'>
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
                    </FieldGroup>
                  </FieldSet>
                ))}
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export { WorkflowSettingsPanel };
