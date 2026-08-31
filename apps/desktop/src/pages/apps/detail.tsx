import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  Kbd,
  KbdGroup,
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
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';

import {
  deleteProcessNode,
  inspectProcessNode,
  listProcessNodeWorkflowReferences,
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
  title: string;
  type: string;
  description: string;
  required: boolean;
  hasDefault: boolean;
  defaultValue: unknown;
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
          title: typeof schema.title === 'string' ? schema.title : '',
          type: contractTypes.includes(type) ? type : 'string',
          description:
            typeof schema.description === 'string' ? schema.description : '',
          required: schema['x-workrun-optional'] !== true,
          hasDefault: Object.hasOwn(schema, 'default'),
          defaultValue: schema.default,
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
      fields.map(
        ({
          key,
          title,
          type,
          description,
          required,
          hasDefault,
          defaultValue,
          schema,
        }) => {
          const next: Record<string, unknown> = { ...schema, type };
          if (title) next.title = title;
          else delete next.title;
          if (description) next.description = description;
          else delete next.description;
          if (required) delete next['x-workrun-optional'];
          else next['x-workrun-optional'] = true;
          if (hasDefault) next.default = defaultValue;
          else delete next.default;
          return [key, next];
        },
      ),
    ),
    null,
    2,
  );
}

function ContractEditor({
  kind,
  value,
  onChange,
}: {
  kind: 'input' | 'output';
  value: string;
  onChange: (value: string) => void;
}) {
  const label = kind === 'input' ? 'Inputs' : 'Outputs';
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
    const base = kind;
    let index = fields.length + 1;
    let key = `${base}_${index}`;
    while (fields.some((field) => field.key === key)) {
      index += 1;
      key = `${base}_${index}`;
    }
    updateFields([
      ...fields,
      {
        key,
        title: '',
        type: 'string',
        description: '',
        required: true,
        hasDefault: false,
        defaultValue: undefined,
        schema: {},
      },
    ]);
  };

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <FieldDescription>
        Define the values this App {label === 'Inputs' ? 'accepts' : 'returns'}.
      </FieldDescription>
      <FieldGroup className='gap-4'>
        {fields.map((field, index) => (
          <FieldSet
            key={`${field.key}-${index}`}
            className='bg-muted/20 gap-4 rounded-xl border p-4'
          >
            <div className='flex items-center justify-between gap-3'>
              <FieldLegend variant='label'>
                {field.title || field.key || `${kind} ${index + 1}`}
              </FieldLegend>
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
            <Field>
              <FieldLabel>Label</FieldLabel>
              <Input
                value={field.title}
                onChange={(event) =>
                  updateField(index, { title: event.target.value })
                }
                placeholder='Shown to people configuring or running this App'
              />
            </Field>
            <FieldGroup className='grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]'>
              <Field>
                <FieldLabel>Field name</FieldLabel>
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
            </FieldGroup>
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
            {kind === 'input' &&
            ['string', 'number', 'integer', 'boolean'].includes(field.type) ? (
              <Field className='gap-3'>
                <Field orientation='horizontal' className='justify-between'>
                  <FieldContent>
                    <FieldLabel>Default value</FieldLabel>
                    <FieldDescription>
                      Use this value when the workflow does not provide the
                      field.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id={`contract-field-default-${kind}-${index}`}
                    checked={field.hasDefault}
                    onCheckedChange={(hasDefault) =>
                      updateField(index, {
                        hasDefault,
                        defaultValue:
                          hasDefault && field.defaultValue === undefined
                            ? field.type === 'boolean'
                              ? false
                              : field.type === 'string'
                                ? ''
                                : 0
                            : field.defaultValue,
                      })
                    }
                  />
                </Field>
                {field.hasDefault ? (
                  field.type === 'boolean' ? (
                    <Field orientation='horizontal'>
                      <Switch
                        id={`contract-field-default-value-${kind}-${index}`}
                        checked={field.defaultValue === true}
                        onCheckedChange={(defaultValue) =>
                          updateField(index, { defaultValue })
                        }
                      />
                      <FieldContent>
                        <FieldLabel
                          htmlFor={`contract-field-default-value-${kind}-${index}`}
                        >
                          Enabled by default
                        </FieldLabel>
                      </FieldContent>
                    </Field>
                  ) : (
                    <Input
                      type={field.type === 'string' ? 'text' : 'number'}
                      step={field.type === 'integer' ? '1' : 'any'}
                      value={
                        typeof field.defaultValue === 'string' ||
                        typeof field.defaultValue === 'number'
                          ? String(field.defaultValue)
                          : ''
                      }
                      onChange={(event) => {
                        const value = event.target.value;
                        updateField(index, {
                          hasDefault: field.type === 'string' || value !== '',
                          defaultValue:
                            field.type === 'string' ? value : Number(value),
                        });
                      }}
                    />
                  )
                ) : null}
              </Field>
            ) : null}
            <Field
              orientation='horizontal'
              className='bg-background rounded-lg border p-3'
            >
              <Switch
                id={`contract-field-required-${label}-${index}`}
                checked={field.required}
                onCheckedChange={(required) => updateField(index, { required })}
              />
              <FieldContent>
                <FieldLabel
                  htmlFor={`contract-field-required-${label}-${index}`}
                >
                  Required
                </FieldLabel>
                <FieldDescription>
                  Require this value when the App is called.
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldSet>
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
      </FieldGroup>
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

type ProcessNodeDetails = Awaited<ReturnType<typeof inspectProcessNode>>;

function ProcessNodeDetailPage() {
  const { id } = useParams();
  const node = useQuery({
    queryKey: ['apps', id],
    queryFn: () => inspectProcessNode(id!),
    enabled: Boolean(id),
  });

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

  if (node.isLoading || !node.data) {
    return (
      <div className='text-muted-foreground p-6 text-sm'>
        Loading Process Node…
      </div>
    );
  }

  return (
    <ProcessNodeDetailEditor
      key={node.data.definition.id}
      processNode={node.data}
    />
  );
}

function ProcessNodeDetailEditor({
  processNode,
}: {
  processNode: ProcessNodeDetails;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DefinitionDraft>(() =>
    toDraft(processNode.definition),
  );
  const [formError, setFormError] = useState<string>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteProjectFiles, setDeleteProjectFiles] = useState(false);

  const workflowReferences = useQuery({
    queryKey: ['apps', processNode.definition.id, 'workflow-references'],
    queryFn: () => listProcessNodeWorkflowReferences(processNode.definition.id),
    enabled: deleteOpen,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!draft.name.trim()) throw new Error('Name is required.');
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
      void navigate(`/apps/${saved.definition.id}`, { replace: true });
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : String(error));
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      deleteProcessNode(processNode.definition.id, deleteProjectFiles),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['apps'] });
      toast.success(
        deleteProjectFiles ? 'App and project files deleted' : 'App removed',
        { toasterId: 'global' },
      );
      void navigate('/apps', { replace: true });
    },
    onError: (error) => {
      toast.error('Could not delete App', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const update = <K extends keyof DefinitionDraft>(
    key: K,
    value: DefinitionDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormError(undefined);
  };

  return (
    <div className='size-full overflow-y-auto'>
      <main className='mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6'>
        <section className='via-background relative flex flex-col gap-4 overflow-hidden rounded-2xl border bg-linear-to-br from-sky-500/10 to-violet-500/8 p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[16px_16px]' />
          <div className='flex min-w-0 items-center gap-3'>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label='Back to apps'
              onClick={() => navigate('/apps')}
            >
              <ArrowLeftIcon />
            </Button>
            <div className='relative'>
              <div className='text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase'>
                Local project
              </div>
              <h1 className='mt-1 text-xl font-semibold tracking-tight'>
                App details
              </h1>
              <p className='text-muted-foreground mt-1 text-sm'>
                Configure this App’s identity, runtime, and data contract.
              </p>
            </div>
          </div>
          <div className='relative flex shrink-0 flex-wrap gap-2'>
            <Button
              variant='destructive'
              disabled={save.isPending}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2Icon data-icon='inline-start' />
              Delete App
            </Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <SaveIcon data-icon='inline-start' />
              )}
              Save changes
            </Button>
          </div>
        </section>

        {formError ? (
          <Alert variant='destructive'>
            <CircleAlertIcon />
            <AlertTitle>Could not save Process Node</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!remove.isPending) setDeleteOpen(open);
          }}
        >
          <AlertDialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl! overflow-y-auto'>
            <AlertDialogHeader>
              <AlertDialogMedia className='bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive'>
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>
                Delete {processNode.definition.name}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This removes the App from Workrun. Local project files are kept
                by default.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {workflowReferences.isLoading ? (
              <p className='text-muted-foreground text-sm'>
                Checking workflow usage…
              </p>
            ) : workflowReferences.data?.length ? (
              <Item variant='muted' size='sm'>
                <ItemMedia variant='icon'>
                  <CircleAlertIcon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {workflowReferences.data.length} affected workflow
                    {workflowReferences.data.length === 1 ? '' : 's'}
                  </ItemTitle>
                  <ItemDescription>
                    Select another App before running these workflows again.
                  </ItemDescription>
                  <KbdGroup>
                    {workflowReferences.data.map((workflow) => (
                      <Kbd key={workflow.id} title={workflow.name}>
                        {workflow.name}
                      </Kbd>
                    ))}
                  </KbdGroup>
                </ItemContent>
              </Item>
            ) : null}
            <Field orientation='horizontal'>
              <Checkbox
                id='delete-process-node-files'
                checked={deleteProjectFiles}
                disabled={remove.isPending}
                onCheckedChange={setDeleteProjectFiles}
              />
              <FieldContent>
                <FieldLabel htmlFor='delete-process-node-files'>
                  Permanently delete local project files
                </FieldLabel>
                <FieldDescription>{processNode.projectPath}</FieldDescription>
              </FieldContent>
            </Field>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                variant='destructive'
                disabled={remove.isPending || workflowReferences.isLoading}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? (
                  <Spinner data-icon='inline-start' />
                ) : (
                  <Trash2Icon data-icon='inline-start' />
                )}
                {deleteProjectFiles ? 'Delete App and files' : 'Delete App'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Card className='shadow-sm'>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>
              Name the node as it should appear in Apps and workflows.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className='gap-6'>
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

        <Card className='shadow-sm'>
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
            <code className='truncate'>{processNode.projectPath}</code>
            <div className='ml-auto flex shrink-0 items-center gap-1'>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label='Open project directory'
                onClick={() =>
                  void openProjectDirectory(processNode.definition.id)
                }
              >
                <FolderOpenIcon />
              </Button>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label='Copy project path'
                onClick={() => void copyProjectPath(processNode.projectPath)}
              >
                <CopyIcon />
              </Button>
            </div>
          </CardFooter>
        </Card>
        <Card className='shadow-sm'>
          <CardHeader>
            <CardTitle>Data contract</CardTitle>
            <CardDescription>
              Define input and output JSON Schema objects for the node.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className='gap-7'>
              <ContractEditor
                kind='input'
                value={draft.inputs}
                onChange={(value) => update('inputs', value)}
              />
              <ContractEditor
                kind='output'
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
