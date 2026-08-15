import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Textarea,
} from '@workspace/ui/components';
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CopyIcon,
  FolderCodeIcon,
  FolderOpenIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';

import {
  inspectProcessNode,
  updateProcessNode,
  type ProcessNodeDefinition,
} from '@/services/process-node';

import { copyProjectPath, openProjectDirectory } from './project-path';

type DefinitionDraft = Omit<ProcessNodeDefinition, 'inputs' | 'outputs'> & {
  inputs: string;
  outputs: string;
};

function toDraft(definition: ProcessNodeDefinition): DefinitionDraft {
  return {
    ...definition,
    inputs: JSON.stringify(definition.inputs, null, 2),
    outputs: JSON.stringify(definition.outputs, null, 2),
  };
}

function parseSchemas(value: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

type ContractField = {
  key: string;
  type: string;
  description: string;
  required: boolean;
  schema: Record<string, unknown>;
};

const contractTypes = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
];

const toolExecutionPolicies = [
  { value: 'ask_every_time', label: 'Ask every time' },
  { value: 'auto', label: 'Run automatically' },
];

function contractFields(value: string): ContractField[] | undefined {
  try {
    const schemas = parseSchemas(value, 'Data contract');
    return Object.entries(schemas).flatMap(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return [];
      const schema = value as Record<string, unknown>;
      const type = typeof schema.type === 'string' ? schema.type : 'string';
      return [
        {
          key,
          type: contractTypes.includes(type) ? type : 'string',
          description:
            typeof schema.description === 'string' ? schema.description : '',
          required: schema['x-workrun-optional'] !== true,
          schema,
        },
      ];
    });
  } catch {
    return undefined;
  }
}

function serializeContractFields(fields: ContractField[]) {
  return JSON.stringify(
    Object.fromEntries(
      fields.map(({ key, type, description, required, schema }) => {
        const next: Record<string, unknown> = { ...schema, type };
        if (description) next.description = description;
        else delete next.description;
        if (required) delete next['x-workrun-optional'];
        else next['x-workrun-optional'] = true;
        return [key, next];
      }),
    ),
    null,
    2,
  );
}

function ContractEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const fields = contractFields(value);
  const updateFields = (next: ContractField[]) =>
    onChange(serializeContractFields(next));

  if (!fields) {
    return (
      <Field data-invalid>
        <FieldLabel>{label}</FieldLabel>
        <FieldError>
          Fix the JSON below before using the field editor.
        </FieldError>
        <Textarea
          className='min-h-44 font-mono text-xs'
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    );
  }

  const updateField = (index: number, patch: Partial<ContractField>) =>
    updateFields(
      fields.map((field, current) =>
        current === index ? { ...field, ...patch } : field,
      ),
    );
  const addField = () => {
    const base = label === 'Inputs' ? 'input' : 'output';
    let index = fields.length + 1;
    let key = `${base}_${index}`;
    while (fields.some((field) => field.key === key)) {
      index += 1;
      key = `${base}_${index}`;
    }
    updateFields([
      ...fields,
      { key, type: 'string', description: '', required: true, schema: {} },
    ]);
  };

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <FieldDescription>
        Define the values this App {label === 'Inputs' ? 'accepts' : 'returns'}.
      </FieldDescription>
      <div className='flex flex-col gap-3'>
        {fields.map((field, index) => (
          <div
            key={`${field.key}-${index}`}
            className='bg-muted/40 grid gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,1fr)_auto_auto] sm:items-end'
          >
            <Field>
              <FieldLabel>Field</FieldLabel>
              <Input
                value={field.key}
                onChange={(event) =>
                  updateField(index, { key: event.target.value })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Type</FieldLabel>
              <Select
                value={field.type}
                onValueChange={(type) => {
                  if (type !== null) updateField(index, { type });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {contractTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Input
                value={field.description}
                onChange={(event) =>
                  updateField(index, { description: event.target.value })
                }
                placeholder='Optional help for the Agent'
              />
            </Field>
            <Field className='w-fit'>
              <FieldLabel>Required</FieldLabel>
              <Switch
                checked={field.required}
                onCheckedChange={(required) => updateField(index, { required })}
              />
            </Field>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={`Remove ${field.key}`}
              onClick={() =>
                updateFields(fields.filter((_, current) => current !== index))
              }
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <Button
          type='button'
          variant='outline'
          className='w-fit'
          onClick={addField}
        >
          <PlusIcon data-icon='inline-start' />
          Add {label === 'Inputs' ? 'input' : 'output'}
        </Button>
      </div>
      <Collapsible className='rounded-md border'>
        <CollapsibleTrigger
          render={
            <Button
              type='button'
              variant='ghost'
              className='w-full justify-start'
            />
          }
        >
          Advanced JSON Schema
        </CollapsibleTrigger>
        <CollapsibleContent className='border-t p-3'>
          <Textarea
            className='min-h-44 font-mono text-xs'
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </CollapsibleContent>
      </Collapsible>
    </Field>
  );
}

function ProcessNodeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DefinitionDraft>();
  const [formError, setFormError] = useState<string>();
  const node = useQuery({
    queryKey: ['apps', id],
    queryFn: () => inspectProcessNode(id!),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (node.data) setDraft(toDraft(node.data.definition));
  }, [node.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft?.name.trim()) throw new Error('Name is required.');
      return updateProcessNode({
        ...draft,
        inputs: parseSchemas(draft.inputs, 'Inputs'),
        outputs: parseSchemas(draft.outputs, 'Outputs'),
      });
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['apps', saved.definition.id], saved);
      void queryClient.invalidateQueries({ queryKey: ['apps'] });
      toast.success('Process Node saved', { toasterId: 'global' });
      navigate(`/apps/${saved.definition.id}`, { replace: true });
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : String(error));
    },
  });

  const update = <K extends keyof DefinitionDraft>(
    key: K,
    value: DefinitionDraft[K],
  ) => {
    setDraft((current) => current && { ...current, [key]: value });
    setFormError(undefined);
  };

  if (node.isError) {
    return (
      <div className='p-6'>
        <Alert variant='destructive'>
          <CircleAlertIcon />
          <AlertTitle>Could not load Process Node</AlertTitle>
          <AlertDescription>
            {node.error instanceof Error
              ? node.error.message
              : 'Please return to Apps and try again.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (node.isLoading || !draft) {
    return (
      <div className='text-muted-foreground p-6 text-sm'>
        Loading Process Node…
      </div>
    );
  }

  return (
    <div className='size-full overflow-y-auto'>
      <main className='mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-5'>
        <div className='flex items-center justify-between gap-3'>
          <div className='flex min-w-0 items-center gap-3'>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label='Back to apps'
              onClick={() => navigate('/apps')}
            >
              <ArrowLeftIcon />
            </Button>
            <div>
              <h1 className='text-lg font-semibold tracking-tight'>
                App details
              </h1>
              <p className='text-muted-foreground text-sm'>
                Configure this App’s identity, runtime, and data contract.
              </p>
            </div>
          </div>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <SaveIcon data-icon='inline-start' />
            )}
            Save changes
          </Button>
        </div>

        {formError ? (
          <Alert variant='destructive'>
            <CircleAlertIcon />
            <AlertTitle>Could not save Process Node</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>
              Name the node as it should appear in Apps and workflows.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={Boolean(formError && !draft.name.trim())}>
                <FieldLabel htmlFor='process-node-name'>Name</FieldLabel>
                <Input
                  id='process-node-name'
                  value={draft.name}
                  onChange={(event) => update('name', event.target.value)}
                  aria-invalid={Boolean(formError && !draft.name.trim())}
                />
                <FieldError>
                  {formError && !draft.name.trim() ? 'Enter a name.' : null}
                </FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor='process-node-description'>
                  Description
                </FieldLabel>
                <Textarea
                  id='process-node-description'
                  value={draft.description}
                  onChange={(event) =>
                    update('description', event.target.value)
                  }
                  placeholder='What does this node do?'
                />
              </Field>
              {draft.kind === 'tool' ? (
                <Field>
                  <FieldLabel>Tool execution</FieldLabel>
                  <FieldDescription>
                    Choose whether an Agent must ask before each call.
                  </FieldDescription>
                  <Select
                    items={toolExecutionPolicies}
                    value={draft.toolExecutionPolicy}
                    onValueChange={(toolExecutionPolicy) => {
                      if (toolExecutionPolicy !== null) {
                        update('toolExecutionPolicy', toolExecutionPolicy);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {toolExecutionPolicies.map((policy) => (
                          <SelectItem key={policy.value} value={policy.value}>
                            {policy.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
            <CardDescription>
              The entry script is relative to this node’s project directory.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className='sm:flex-row'>
              <Field>
                <FieldLabel htmlFor='process-node-version'>Version</FieldLabel>
                <Input
                  id='process-node-version'
                  value={draft.version}
                  onChange={(event) => update('version', event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor='process-node-entry'>
                  Entry script
                </FieldLabel>
                <Input
                  id='process-node-entry'
                  value={draft.entry}
                  onChange={(event) => update('entry', event.target.value)}
                />
              </Field>
            </FieldGroup>
          </CardContent>
          <CardFooter className='text-muted-foreground text-sm'>
            <FolderCodeIcon data-icon='inline-start' />
            <code className='truncate'>{node.data?.projectPath}</code>
            <div className='ml-auto flex shrink-0 items-center gap-1'>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label='Open project directory'
                onClick={() =>
                  void openProjectDirectory(node.data!.definition.id)
                }
              >
                <FolderOpenIcon />
              </Button>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label='Copy project path'
                onClick={() => void copyProjectPath(node.data!.projectPath)}
              >
                <CopyIcon />
              </Button>
            </div>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Data contract</CardTitle>
            <CardDescription>
              Define input and output JSON Schema objects for the node.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <ContractEditor
                label='Inputs'
                value={draft.inputs}
                onChange={(value) => update('inputs', value)}
              />
              <ContractEditor
                label='Outputs'
                value={draft.outputs}
                onChange={(value) => update('outputs', value)}
              />
            </FieldGroup>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

export { ProcessNodeDetailPage as Component };
