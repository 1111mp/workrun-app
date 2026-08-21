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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
  kind: z.enum(['workflow', 'tool']),
});

type CreateProcessNodeForm = z.infer<typeof createAppSchema>;

const createStageLabels: Record<ProcessNodeCreateStage, string> = {
  creatingProject: 'Creating project…',
  addingSdkDependency: 'Adding Python SDK…',
  initializingEnvironment: 'Initializing project environment…',
  savingApp: 'Saving app…',
  completed: 'App created',
};

const appKinds = [
  { value: 'workflow', label: 'App' },
  { value: 'tool', label: 'Tool App' },
];

function CreateProcessNodePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createStage, setCreateStage] = useState<ProcessNodeCreateStage>();
  const form = useForm<CreateProcessNodeForm>({
    resolver: zodResolver(createAppSchema),
    defaultValues: { name: '', description: '', kind: 'workflow' },
  });

  const create = useMutation({
    mutationFn: (request: CreateProcessNodeForm) =>
      createProcessNode(request, (progress) => setCreateStage(progress.stage)),
    onMutate: () => setCreateStage('creatingProject'),
    onSuccess: (node) => {
      void queryClient.invalidateQueries({ queryKey: ['apps'] });
      toast.success('App created', { toasterId: 'global' });
      void navigate(`/apps/${node.definition.id}`, { replace: true });
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
      <main className='mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6'>
        <section className='via-background relative overflow-hidden rounded-2xl border bg-linear-to-br from-sky-500/10 to-violet-500/8 p-5 shadow-sm sm:p-6'>
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
                Create an App
              </h1>
              <p className='text-muted-foreground mt-1 text-sm'>
                Start with an editable local Python project.
              </p>
            </div>
          </div>
        </section>

        <Card className='shadow-sm'>
          <CardHeader>
            <CardTitle>App details</CardTitle>
            <CardDescription>
              Give the project a recognizable name, then choose how it will be
              used.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form id='form-create-app' onSubmit={submit}>
              <FieldGroup className='gap-6'>
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
                <Controller
                  name='kind'
                  control={form.control}
                  render={({ field }) => (
                    <Field>
                      <FieldLabel htmlFor='app-kind'>App type</FieldLabel>
                      <FieldDescription>
                        Apps run independently and can also be added as canvas
                        nodes. Tool Apps are called by Agents with structured
                        arguments.
                      </FieldDescription>
                      <Select
                        items={appKinds}
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger id='app-kind' className='w-full'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {appKinds.map((kind) => (
                            <SelectItem key={kind.value} value={kind.value}>
                              {kind.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
