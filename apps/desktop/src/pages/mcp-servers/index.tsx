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
  AlertDialogTitle,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
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
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Textarea,
} from '@workspace/ui/components';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  CloudIcon,
  CommandIcon,
  CpuIcon,
  PencilIcon,
  PlusIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  authorizeMcpServer,
  createMcpServer,
  deleteMcpServer,
  listMcpServerWorkflowReferences,
  listMcpServers,
  reconnectMcpServer,
  startMcpServer,
  stopMcpServer,
  testMcpServerConnection,
  updateMcpServer,
  type CreateMcpServerRequest,
  type McpServer,
  type McpServerConnectionTest,
  type McpServerDefinition,
  type McpServerHealth,
  type TestMcpServerConnectionRequest,
  type UpdateMcpServerRequest,
} from '@/services/mcp-server';

type Draft = CreateMcpServerRequest & { id?: string };
type ServerLocation = 'local' | 'remote';

const emptyDraft = (): Draft => ({
  name: '',
  description: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  auth: 'none',
  enabled: true,
});

function formatEnvironment(env: Record<string, string>) {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}

function parseEnvironment(lines: string) {
  return Object.fromEntries(
    lines
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1)];
      }),
  );
}

function statusLabel(server: McpServer) {
  if (server.status === 'Running') return 'Online';
  if (server.status === 'Disabled') return 'Disabled';
  if (server.status === 'FailedToStart' || server.status === 'Crashed') {
    return 'Attention needed';
  }
  if (server.status === 'Restarting') return 'Restarting';
  return 'Offline';
}

function statusTone(server: McpServer) {
  if (server.status === 'Running') return 'bg-emerald-500';
  if (server.status === 'FailedToStart' || server.status === 'Crashed') {
    return 'bg-destructive';
  }
  if (server.status === 'Restarting') return 'bg-amber-500';
  return 'bg-muted-foreground/40';
}

function diagnosticTime(timestamp?: string) {
  return timestamp ? new Date(timestamp).toLocaleString() : undefined;
}

function serverLocation(server: McpServer): ServerLocation {
  return server.definition.transport === 'streamable_http' ? 'remote' : 'local';
}

function locationPresentation(location: ServerLocation) {
  return location === 'remote'
    ? {
        label: 'Remote',
        icon: CloudIcon,
        cardClass: 'bg-violet-500/[0.045] hover:bg-violet-500/[0.075]',
        iconClass:
          'border-violet-200/70 bg-gradient-to-br from-violet-500/[0.18] to-fuchsia-500/[0.12] text-violet-700 dark:border-violet-400/15 dark:text-violet-300',
        labelClass:
          'border-violet-500/20 bg-violet-500/10 text-violet-700 dark:text-violet-300',
      }
    : {
        label: 'Local',
        icon: TerminalIcon,
        cardClass: 'bg-sky-500/[0.035] hover:bg-sky-500/[0.065]',
        iconClass:
          'border-sky-200/70 bg-gradient-to-br from-sky-500/[0.16] to-cyan-500/[0.12] text-sky-700 dark:border-sky-400/15 dark:text-sky-300',
        labelClass:
          'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      };
}

function McpServersPage() {
  const queryClient = useQueryClient();
  const servers = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: listMcpServers,
    refetchInterval: (query) => {
      const configuredServers = query.state.data ?? [];
      if (
        configuredServers.some(
          (server) => server.definition.authorizationStatus === 'authorizing',
        )
      ) {
        return 2_000;
      }
      return configuredServers.some(
        (server) =>
          server.status === 'Running' || server.status === 'Restarting',
      )
        ? 10_000
        : false;
    },
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<McpServerDefinition | null>(null);
  const workflowReferences = useQuery({
    queryKey: ['mcp-server-workflow-references', deleting?.id],
    queryFn: () =>
      deleting
        ? listMcpServerWorkflowReferences(deleting.id)
        : Promise.resolve([]),
    enabled: Boolean(deleting),
  });
  const configuredServers = servers.data ?? [];
  const runningCount = configuredServers.filter(
    (server) => server.status === 'Running',
  ).length;
  const attentionCount = configuredServers.filter(
    (server) =>
      server.status === 'FailedToStart' || server.status === 'Crashed',
  ).length;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
  const save = useMutation({
    mutationFn: async (next: Draft) => {
      const request = { ...next, args: next.args.filter(Boolean) };
      return next.id
        ? updateMcpServer(request as UpdateMcpServerRequest)
        : createMcpServer(request);
    },
    onSuccess: () => {
      setDraft(null);
      void refresh();
    },
    onError: (error) =>
      toast.error('Could not save MCP server', {
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  const lifecycle = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' }) =>
      action === 'start' ? startMcpServer(id) : stopMcpServer(id),
    onError: (error) =>
      toast.error('Could not start MCP server', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      }),
    onSettled: () => void refresh(),
  });
  const authorize = useMutation({
    mutationFn: authorizeMcpServer,
    onSuccess: () => {
      toast.info('Authorization opened in your browser.');
      void refresh();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : String(error)),
  });
  const reconnect = useMutation({
    mutationFn: reconnectMcpServer,
    onError: (error) =>
      toast.error('Could not reconnect to MCP server', {
        description: error instanceof Error ? error.message : String(error),
      }),
    onSettled: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: deleteMcpServer,
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
    onError: (error) => toast.error(String(error)),
  });

  return (
    <div className='size-full overflow-y-auto'>
      <div className='mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8'>
        <section className='via-card relative overflow-hidden rounded-2xl border border-sky-200/70 bg-linear-to-br from-sky-500/12 to-violet-500/10 shadow-sm dark:border-sky-400/15'>
          <div className='pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(214_90%_60%/0.14)_1px,transparent_1px),linear-gradient(to_bottom,hsl(214_90%_60%/0.14)_1px,transparent_1px)] [background-size:28px_28px]' />
          <div className='relative flex flex-col gap-6 p-5 sm:p-7 lg:flex-row lg:items-end lg:justify-between'>
            <div className='max-w-xl'>
              <div className='text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium tracking-[0.16em] uppercase'>
                <RadioTowerIcon className='size-3.5' />
                MCP tool registry
              </div>
              <h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
                MCP servers
              </h1>
              <p className='text-muted-foreground mt-2 text-sm leading-6'>
                Connect local stdio or remote Streamable HTTP servers and make
                their tools available to your workflows.
              </p>
            </div>
            <div className='flex flex-col gap-3 sm:flex-row sm:items-center'>
              <div className='bg-background/70 flex divide-x divide-sky-200/70 rounded-xl border border-sky-200/70 shadow-xs backdrop-blur-sm dark:divide-sky-400/15 dark:border-sky-400/15'>
                <div className='px-4 py-2.5'>
                  <div className='text-muted-foreground text-[11px] font-medium tracking-wide uppercase'>
                    Connected
                  </div>
                  <div className='mt-0.5 flex items-center gap-1.5 text-sm font-semibold tabular-nums'>
                    <span className='size-1.5 rounded-full bg-emerald-500' />
                    {runningCount} online
                  </div>
                </div>
                <div className='px-4 py-2.5'>
                  <div className='text-muted-foreground text-[11px] font-medium tracking-wide uppercase'>
                    Registry
                  </div>
                  <div className='mt-0.5 text-sm font-semibold tabular-nums'>
                    {configuredServers.length} servers
                  </div>
                </div>
              </div>
              <Button onClick={() => setDraft(emptyDraft())}>
                <PlusIcon data-icon='inline-start' />
                Add server
              </Button>
            </div>
          </div>
        </section>
        <div className='flex items-center justify-between gap-4'>
          <div>
            <h2 className='text-sm font-semibold'>Your servers</h2>
            <p className='text-muted-foreground mt-0.5 text-xs'>
              Start a server to expose its tools to Workrun.
            </p>
          </div>
          {attentionCount ? (
            <div className='text-destructive flex items-center gap-1.5 text-xs font-medium'>
              <CircleAlertIcon className='size-3.5' />
              {attentionCount} needs attention
            </div>
          ) : null}
        </div>
        {servers.isLoading ? (
          <div className='text-muted-foreground bg-card flex items-center gap-2 rounded-xl border px-4 py-8 text-sm'>
            <Spinner /> Loading server registry…
          </div>
        ) : null}
        {servers.data?.length ? (
          <div className='grid gap-3'>
            {servers.data.map((server) => {
              const isRunning = server.status === 'Running';
              const needsRetry =
                server.status === 'FailedToStart' ||
                server.status === 'Crashed';
              const isRestarting = server.status === 'Restarting';
              const location = locationPresentation(serverLocation(server));
              const LocationIcon = location.icon;
              const isPending =
                lifecycle.isPending &&
                lifecycle.variables?.id === server.definition.id;
              const isReconnecting =
                reconnect.isPending &&
                reconnect.variables === server.definition.id;
              return (
                <Card
                  key={server.definition.id}
                  className={`group relative overflow-hidden border-l-4 shadow-none backdrop-blur-sm transition-colors ${location.cardClass}`}
                  style={{
                    borderLeftColor:
                      server.status === 'Running'
                        ? 'hsl(142 71% 45%)'
                        : server.status === 'FailedToStart' ||
                            server.status === 'Crashed'
                          ? 'hsl(var(--destructive))'
                          : 'hsl(var(--border))',
                  }}
                >
                  <CardContent className='grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5'>
                    <div className='min-w-0'>
                      <div className='flex items-start gap-3'>
                        <div
                          className={`flex size-9 shrink-0 items-center justify-center rounded-lg border ${location.iconClass}`}
                        >
                          <LocationIcon className='size-4.5' />
                        </div>
                        <div className='min-w-0'>
                          <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                            <CardTitle className='text-sm'>
                              {server.definition.name}
                            </CardTitle>
                            <span
                              className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${location.labelClass}`}
                            >
                              {location.label}
                            </span>
                            <span className='text-muted-foreground flex items-center gap-1.5 text-xs'>
                              <span
                                className={`size-1.5 rounded-full ${statusTone(server)}`}
                              />
                              {statusLabel(server)}
                            </span>
                          </div>
                          <CardDescription className='mt-1 line-clamp-1'>
                            {server.definition.description ||
                              'No description provided.'}
                          </CardDescription>
                        </div>
                      </div>
                      <div className='bg-muted/45 mt-3 flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs'>
                        <CommandIcon className='text-muted-foreground size-3.5 shrink-0' />
                        <code className='text-foreground/85 min-w-0 truncate font-mono'>
                          {server.definition.transport === 'streamable_http'
                            ? server.definition.url
                            : [
                                server.definition.command,
                                ...server.definition.args,
                              ].join(' ')}
                        </code>
                      </div>
                      {server.health.lastError ? (
                        <p className='text-destructive mt-2 line-clamp-1 text-xs'>
                          Last check failed: {server.health.lastError}
                        </p>
                      ) : server.health.lastCheckedAt ? (
                        <p className='text-muted-foreground mt-2 text-xs'>
                          Last checked{' '}
                          {diagnosticTime(server.health.lastCheckedAt)}
                          {server.health.toolCount !== undefined
                            ? ` · ${server.health.toolCount} tools discovered`
                            : null}
                        </p>
                      ) : null}
                    </div>
                    <div className='flex items-center justify-between gap-2 border-t pt-3 sm:justify-end sm:border-t-0 sm:pt-0'>
                      {isRestarting ? (
                        <Button variant='outline' size='sm' disabled>
                          <Spinner data-icon='inline-start' />
                          Reconnecting
                        </Button>
                      ) : server.status !== 'Disabled' ? (
                        <>
                          {isRunning ? (
                            <Button
                              variant='outline'
                              size='sm'
                              disabled={isReconnecting}
                              onClick={() =>
                                reconnect.mutate(server.definition.id)
                              }
                            >
                              {isReconnecting ? (
                                <Spinner data-icon='inline-start' />
                              ) : (
                                <RefreshCwIcon data-icon='inline-start' />
                              )}
                              Reconnect
                            </Button>
                          ) : null}
                          <Button
                            variant='outline'
                            size='sm'
                            disabled={isPending || isReconnecting}
                            onClick={() =>
                              lifecycle.mutate({
                                id: server.definition.id,
                                action: isRunning ? 'stop' : 'start',
                              })
                            }
                          >
                            {isPending ? (
                              <Spinner data-icon='inline-start' />
                            ) : isRunning ? (
                              <CirclePauseIcon data-icon='inline-start' />
                            ) : (
                              <CirclePlayIcon data-icon='inline-start' />
                            )}
                            {isRunning
                              ? 'Stop'
                              : needsRetry
                                ? 'Retry'
                                : 'Start'}
                          </Button>
                        </>
                      ) : null}
                      {server.definition.auth === 'oauth' ? (
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={
                            authorize.isPending ||
                            server.definition.authorizationStatus ===
                              'authorizing'
                          }
                          onClick={() => authorize.mutate(server.definition.id)}
                        >
                          {authorize.isPending ? (
                            <Spinner data-icon='inline-start' />
                          ) : null}
                          {server.definition.authorizationStatus ===
                          'authorized'
                            ? 'Reauthorize'
                            : 'Authorize'}
                        </Button>
                      ) : null}
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => setDraft(server.definition)}
                      >
                        <PencilIcon data-icon='inline-start' />
                        Edit
                      </Button>
                      <Button
                        variant='ghost'
                        size='icon-sm'
                        aria-label={`Delete ${server.definition.name}`}
                        className='text-muted-foreground hover:text-destructive'
                        onClick={() => setDeleting(server.definition)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : !servers.isLoading ? (
          <Empty className='via-card border border-dashed border-sky-200/70 bg-linear-to-br from-sky-500/6 to-violet-500/5 py-14 dark:border-sky-400/15'>
            <EmptyHeader>
              <EmptyMedia variant='icon' className='rounded-xl'>
                <CpuIcon />
              </EmptyMedia>
              <EmptyTitle>No MCP servers configured</EmptyTitle>
              <EmptyDescription>
                Add a stdio or Streamable HTTP server to make its tools
                available in your workflows.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant='outline' onClick={() => setDraft(emptyDraft())}>
                <PlusIcon data-icon='inline-start' />
                Add server
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
        <McpServerDialog
          key={draft?.id ?? (draft ? 'new' : 'closed')}
          draft={draft}
          health={
            draft
              ? configuredServers.find(
                  (server) => server.definition.id === draft.id,
                )?.health
              : undefined
          }
          isSaving={save.isPending}
          onOpenChange={(open) => !open && setDraft(null)}
          onSave={(next) => save.mutate(next)}
          onDiagnosticsUpdated={() => void refresh()}
        />
        <AlertDialog
          open={Boolean(deleting)}
          onOpenChange={(open) => !open && setDeleting(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete MCP server?</AlertDialogTitle>
              <AlertDialogDescription>
                This stops the server and removes its local configuration.
                {workflowReferences.isLoading
                  ? ' Checking workflows that use its tools…'
                  : workflowReferences.data?.length
                    ? ` ${workflowReferences.data.length} workflow${workflowReferences.data.length === 1 ? '' : 's'} will retain unavailable tool selections: ${workflowReferences.data.map((workflow) => workflow.name).join(', ')}.`
                    : ' No saved workflows reference its tools.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={remove.isPending || workflowReferences.isLoading}
                onClick={() => deleting && remove.mutate(deleting.id)}
              >
                {remove.isPending ? (
                  <Spinner data-icon='inline-start' />
                ) : (
                  <Trash2Icon data-icon='inline-start' />
                )}
                Delete server
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

function McpServerDialog({
  draft,
  health,
  isSaving,
  onOpenChange,
  onSave,
  onDiagnosticsUpdated,
}: {
  draft: Draft | null;
  health?: McpServerHealth;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: Draft) => void;
  onDiagnosticsUpdated: () => void;
}) {
  const [formDraft, setFormDraft] = useState<Draft | null>(draft);
  const [argsText, setArgsText] = useState(() => draft?.args.join('\n') ?? '');
  const [environmentText, setEnvironmentText] = useState(() =>
    draft ? formatEnvironment(draft.env) : '',
  );
  const [testResult, setTestResult] = useState<
    | {
        signature: string;
        result?: McpServerConnectionTest;
        error?: string;
      }
    | undefined
  >();

  const isOpen = formDraft !== null;
  const hasInvalidEnvironmentLine = environmentText
    .split('\n')
    .some((line) => line.trim() && line.indexOf('=') <= 0);
  const testRequest: TestMcpServerConnectionRequest | undefined = formDraft
    ? {
        id: formDraft.id,
        name: formDraft.name,
        transport: formDraft.transport,
        command: formDraft.command,
        args: argsText
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        env: parseEnvironment(environmentText),
        url: formDraft.url,
        auth: formDraft.auth,
        bearerToken: formDraft.bearerToken,
      }
    : undefined;

  const testSignature = JSON.stringify(testRequest);

  const testConnection = useMutation({
    mutationFn: testMcpServerConnection,
    onSuccess: (result, request) =>
      setTestResult({ signature: JSON.stringify(request), result }),
    onError: (error, request) =>
      setTestResult({
        signature: JSON.stringify(request),
        error: error instanceof Error ? error.message : String(error),
      }),
    onSettled: () => onDiagnosticsUpdated(),
  });

  const currentTestResult =
    testResult?.signature === testSignature ? testResult : undefined;
  const canTest =
    Boolean(testRequest?.name.trim()) &&
    !hasInvalidEnvironmentLine &&
    Boolean(
      testRequest?.transport === 'stdio'
        ? testRequest.command.trim()
        : testRequest?.url.trim(),
    );

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-3xl! gap-0 overflow-hidden p-0'>
        <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/12 to-violet-500/10 px-6 py-6 pr-14'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.16)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
          <div className='relative flex items-start gap-3'>
            <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
              {formDraft?.transport === 'streamable_http' ? (
                <CloudIcon className='size-5' />
              ) : (
                <TerminalIcon className='size-5' />
              )}
            </div>
            <div className='min-w-0'>
              <DialogTitle className='text-lg'>
                {formDraft?.id ? 'Edit MCP server' : 'Connect an MCP server'}
              </DialogTitle>
              <DialogDescription className='mt-1 max-w-xl leading-5'>
                {formDraft?.id
                  ? 'Update the connection details and availability for this server.'
                  : 'Add a local process or a remote Streamable HTTP endpoint to your tool registry.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {formDraft ? (
          <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
            <FieldGroup className='gap-7'>
              <FieldSet>
                <FieldLegend>Server details</FieldLegend>
                <FieldDescription>
                  Use a recognizable name so collaborators can find this tool
                  connection in a workflow.
                </FieldDescription>
                <FieldGroup className='grid gap-4 sm:grid-cols-2'>
                  <Field>
                    <FieldLabel htmlFor='mcp-server-name'>Name</FieldLabel>
                    <Input
                      id='mcp-server-name'
                      placeholder='e.g. GitHub MCP'
                      value={formDraft.name}
                      onChange={(event) =>
                        setFormDraft({ ...formDraft, name: event.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor='mcp-server-description'>
                      Description
                    </FieldLabel>
                    <Input
                      id='mcp-server-description'
                      placeholder='e.g. Search and manage GitHub repositories'
                      value={formDraft.description}
                      onChange={(event) =>
                        setFormDraft({
                          ...formDraft,
                          description: event.target.value,
                        })
                      }
                    />
                  </Field>
                </FieldGroup>
              </FieldSet>

              <FieldSet className='bg-muted/20 rounded-xl border p-4 sm:p-5'>
                <FieldLegend>Connection</FieldLegend>
                <FieldDescription>
                  Choose where this server runs, then provide the connection
                  details.
                </FieldDescription>
                <FieldGroup className='gap-4'>
                  <Field>
                    <FieldLabel htmlFor='mcp-server-location'>
                      Connection type
                    </FieldLabel>
                    <Select
                      value={
                        formDraft.transport === 'streamable_http'
                          ? 'Remote MCP Server'
                          : 'Local MCP Server'
                      }
                      onValueChange={(location) =>
                        setFormDraft({
                          ...formDraft,
                          transport:
                            location === 'remote' ? 'streamable_http' : 'stdio',
                        })
                      }
                    >
                      <SelectTrigger
                        id='mcp-server-location'
                        className='w-full'
                      >
                        <SelectValue placeholder='Select a connection type' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='local'>
                          Local process (stdio)
                        </SelectItem>
                        <SelectItem value='remote'>
                          Remote endpoint (HTTP)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className='bg-background/70 flex items-start gap-3 rounded-lg border p-3'>
                    <div className='bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg'>
                      {formDraft.transport === 'stdio' ? (
                        <TerminalIcon className='size-4' />
                      ) : (
                        <CloudIcon className='size-4' />
                      )}
                    </div>
                    <div>
                      <div className='text-sm font-medium'>
                        {formDraft.transport === 'stdio'
                          ? 'Managed local process'
                          : 'Streamable HTTP endpoint'}
                      </div>
                      <p className='text-muted-foreground mt-0.5 text-xs leading-5'>
                        {formDraft.transport === 'stdio'
                          ? 'Workrun starts and communicates with a stdio process on this device.'
                          : 'Workrun connects to a hosted MCP server using its public endpoint.'}
                      </p>
                    </div>
                  </div>
                  {formDraft.transport === 'stdio' ? (
                    <FieldGroup className='gap-4'>
                      <Field>
                        <FieldLabel htmlFor='mcp-server-command'>
                          Command
                        </FieldLabel>
                        <Input
                          id='mcp-server-command'
                          placeholder='npx'
                          value={formDraft.command}
                          onChange={(event) =>
                            setFormDraft({
                              ...formDraft,
                              command: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor='mcp-server-args'>
                          Arguments
                        </FieldLabel>
                        <Textarea
                          id='mcp-server-args'
                          className='min-h-24 font-mono text-xs'
                          placeholder={
                            '-y\n@modelcontextprotocol/server-everything'
                          }
                          value={argsText}
                          onChange={(event) => setArgsText(event.target.value)}
                        />
                        <FieldDescription>
                          Enter one command argument per line.
                        </FieldDescription>
                      </Field>
                      <Field
                        data-invalid={hasInvalidEnvironmentLine || undefined}
                      >
                        <FieldLabel htmlFor='mcp-server-environment'>
                          Environment variables
                        </FieldLabel>
                        <Textarea
                          id='mcp-server-environment'
                          className='min-h-24 font-mono text-xs'
                          placeholder={
                            'GITHUB_TOKEN=…\nAPI_BASE_URL=https://api.example.com'
                          }
                          value={environmentText}
                          aria-invalid={hasInvalidEnvironmentLine}
                          onChange={(event) =>
                            setEnvironmentText(event.target.value)
                          }
                        />
                        <FieldDescription>
                          One <code>KEY=value</code> pair per line. Values are
                          encrypted with this server configuration.
                        </FieldDescription>
                      </Field>
                    </FieldGroup>
                  ) : (
                    <FieldGroup className='gap-4'>
                      <Field>
                        <FieldLabel htmlFor='mcp-server-url'>
                          Endpoint URL
                        </FieldLabel>
                        <Input
                          id='mcp-server-url'
                          type='url'
                          placeholder='https://example.com/mcp'
                          value={formDraft.url}
                          onChange={(event) =>
                            setFormDraft({
                              ...formDraft,
                              url: event.target.value,
                            })
                          }
                        />
                        <FieldDescription>
                          The server must support MCP Streamable HTTP.
                        </FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor='mcp-server-auth'>
                          Authentication
                        </FieldLabel>
                        <Select
                          value={formDraft.auth}
                          onValueChange={(auth) =>
                            setFormDraft({
                              ...formDraft,
                              auth: auth as 'none' | 'bearer' | 'oauth',
                            })
                          }
                        >
                          <SelectTrigger
                            id='mcp-server-auth'
                            className='w-full'
                          >
                            <SelectValue placeholder='Select authentication'>
                              {formDraft.auth === 'bearer'
                                ? 'Bearer Token'
                                : formDraft.auth === 'oauth'
                                  ? 'OAuth'
                                  : 'No authentication'}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='none'>
                              No authentication
                            </SelectItem>
                            <SelectItem value='bearer'>Bearer token</SelectItem>
                            <SelectItem value='oauth'>OAuth</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                      {formDraft.auth === 'bearer' ? (
                        <Field>
                          <FieldLabel htmlFor='mcp-server-token'>
                            Bearer token
                          </FieldLabel>
                          <Input
                            id='mcp-server-token'
                            type='password'
                            placeholder='Paste token'
                            value={formDraft.bearerToken ?? ''}
                            onChange={(event) =>
                              setFormDraft({
                                ...formDraft,
                                bearerToken: event.target.value,
                              })
                            }
                          />
                          <FieldDescription>
                            Stored encrypted. Leave empty to retain the saved
                            token.
                          </FieldDescription>
                        </Field>
                      ) : formDraft.auth === 'oauth' ? (
                        <div className='border-primary/15 bg-primary/5 flex items-start gap-2 rounded-lg border p-3 text-sm'>
                          <ShieldCheckIcon className='text-primary mt-0.5 size-4 shrink-0' />
                          <p className='text-muted-foreground leading-5'>
                            Save this server, then authorize it in your browser.
                            Credentials are stored encrypted.
                          </p>
                        </div>
                      ) : null}
                    </FieldGroup>
                  )}
                </FieldGroup>
              </FieldSet>

              <FieldSet>
                <FieldLegend>Availability</FieldLegend>
                <Field
                  orientation='horizontal'
                  className='bg-background rounded-xl border p-4'
                >
                  <Switch
                    id='mcp-server-enabled'
                    checked={formDraft.enabled}
                    onCheckedChange={(enabled) =>
                      setFormDraft({ ...formDraft, enabled })
                    }
                  />
                  <FieldContent>
                    <FieldLabel
                      htmlFor='mcp-server-enabled'
                      className='flex items-center gap-2'
                    >
                      Enable this server
                      <span
                        className={`size-1.5 rounded-full ${formDraft.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                      />
                    </FieldLabel>
                    <FieldDescription>
                      Disabled servers remain saved but cannot be started or
                      used by workflows.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldSet>
              {health?.lastCheckedAt ? (
                <Alert variant={health.lastError ? 'destructive' : 'default'}>
                  {health.lastError ? <CircleAlertIcon /> : <CircleCheckIcon />}
                  <AlertTitle>
                    {health.lastError
                      ? 'Latest connection check failed'
                      : 'Latest connection check succeeded'}
                  </AlertTitle>
                  <AlertDescription>
                    Checked {diagnosticTime(health.lastCheckedAt)}.
                    {health.lastError
                      ? ` ${health.lastError}`
                      : health.toolCount !== undefined
                        ? ` ${health.toolCount} tools discovered.`
                        : null}
                  </AlertDescription>
                </Alert>
              ) : null}
              {currentTestResult?.result ? (
                <Alert>
                  <CircleCheckIcon />
                  <AlertTitle>Connection successful</AlertTitle>
                  <AlertDescription>
                    {currentTestResult.result.toolNames.length
                      ? `Discovered ${currentTestResult.result.toolNames.length} tools: ${currentTestResult.result.toolNames.join(', ')}.`
                      : 'The server connected but did not advertise any tools.'}
                  </AlertDescription>
                </Alert>
              ) : currentTestResult?.error ? (
                <Alert variant='destructive'>
                  <CircleAlertIcon />
                  <AlertTitle>Connection failed</AlertTitle>
                  <AlertDescription>{currentTestResult.error}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </div>
        ) : null}
        <DialogFooter>
          <Button
            variant='outline'
            disabled={testConnection.isPending || !canTest}
            onClick={() => testRequest && testConnection.mutate(testRequest)}
          >
            {testConnection.isPending ? (
              <Spinner data-icon='inline-start' />
            ) : null}
            Test connection
          </Button>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={isSaving || !canTest}
            onClick={() =>
              formDraft &&
              onSave({
                ...formDraft,
                args: argsText
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
                env: parseEnvironment(environmentText),
              })
            }
          >
            {isSaving ? <Spinner data-icon='inline-start' /> : null}Save server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { McpServersPage as Component };
