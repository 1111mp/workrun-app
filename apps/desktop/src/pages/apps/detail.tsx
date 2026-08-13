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
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Spinner,
  Textarea,
} from '@workspace/ui/components';
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CopyIcon,
  FolderCodeIcon,
  FolderOpenIcon,
  SaveIcon,
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
                Process Node details
              </h1>
              <p className='text-muted-foreground text-sm'>
                Manage the metadata used by this local project.
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
              <Field>
                <FieldLabel htmlFor='process-node-inputs'>Inputs</FieldLabel>
                <Textarea
                  id='process-node-inputs'
                  className='min-h-44 font-mono text-xs'
                  value={draft.inputs}
                  onChange={(event) => update('inputs', event.target.value)}
                />
                <FieldDescription>
                  Map each input name to a JSON Schema object.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor='process-node-outputs'>Outputs</FieldLabel>
                <Textarea
                  id='process-node-outputs'
                  className='min-h-44 font-mono text-xs'
                  value={draft.outputs}
                  onChange={(event) => update('outputs', event.target.value)}
                />
                <FieldDescription>
                  Map each output name to a JSON Schema object.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

export { ProcessNodeDetailPage as Component };
