import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Spinner,
  Textarea,
} from '@workspace/ui/components';
import { ArrowLeftIcon, SaveIcon } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';

import {
  createProcessNode,
  type ProcessNodeCreateStage,
} from '@/services/process-node';

const createAppSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.'),
  description: z.string(),
});

type CreateProcessNodeForm = z.infer<typeof createAppSchema>;

const createStageLabels: Record<ProcessNodeCreateStage, string> = {
  creatingProject: 'Creating project…',
  addingSdkDependency: 'Adding Python SDK…',
  initializingEnvironment: 'Initializing project environment…',
  savingApp: 'Saving app…',
  completed: 'App created',
};

function CreateProcessNodePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createStage, setCreateStage] = useState<ProcessNodeCreateStage>();
  const form = useForm<CreateProcessNodeForm>({
    resolver: zodResolver(createAppSchema),
    defaultValues: { name: '', description: '' },
  });

  const create = useMutation({
    mutationFn: (request: CreateProcessNodeForm) =>
      createProcessNode(request, (progress) => setCreateStage(progress.stage)),
    onMutate: () => setCreateStage('creatingProject'),
    onSuccess: (node) => {
      void queryClient.invalidateQueries({ queryKey: ['apps'] });
      toast.success('App created', { toasterId: 'global' });
      navigate(`/apps/${node.definition.id}`, { replace: true });
    },
    onError: (error) => {
      setCreateStage(undefined);
      toast.error('Could not create app', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const submit = form.handleSubmit((values) => create.mutate(values));

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
                Create App
              </h1>
              <p className='text-muted-foreground text-sm'>
                Start with an editable local Python project.
              </p>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>
              Name the node as it should appear in Apps and workflows.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form id='form-create-app' onSubmit={submit}>
              <FieldGroup>
                <Controller
                  name='name'
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor='app-name'>Name</FieldLabel>
                      <Input
                        {...field}
                        id='app-name'
                        placeholder='Please enter app name'
                        aria-invalid={fieldState.invalid}
                        autoComplete='off'
                      />
                      {fieldState.invalid ? (
                        <FieldError errors={[fieldState.error]} />
                      ) : null}
                    </Field>
                  )}
                />
                <Controller
                  name='description'
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor='app-description'>
                        Description
                      </FieldLabel>
                      <Textarea
                        {...field}
                        id='app-description'
                        placeholder='What does this app do?'
                        aria-invalid={fieldState.invalid}
                      />
                      {fieldState.invalid ? (
                        <FieldError errors={[fieldState.error]} />
                      ) : null}
                    </Field>
                  )}
                />
              </FieldGroup>
            </form>
          </CardContent>
          <CardFooter>
            <Field orientation='horizontal' className='justify-end'>
              {create.isPending && createStage ? (
                <span className='text-muted-foreground mr-auto text-sm'>
                  {createStageLabels[createStage]}
                </span>
              ) : null}
              <Button
                type='button'
                variant='outline'
                onClick={() => navigate('/apps')}
              >
                Cancel
              </Button>
              <Button
                type='submit'
                form='form-create-app'
                disabled={create.isPending}
              >
                {create.isPending ? (
                  <Spinner data-icon='inline-start' />
                ) : (
                  <SaveIcon data-icon='inline-start' />
                )}
                {create.isPending && createStage
                  ? createStageLabels[createStage]
                  : 'Create project'}
              </Button>
            </Field>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}

export { CreateProcessNodePage as Component };
