import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  CirclePauseIcon,
  CirclePlayIcon,
  CloudIcon,
  CommandIcon,
  CpuIcon,
  PencilIcon,
  PlusIcon,
  RadioTowerIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  createMcpServer,
  authorizeMcpServer,
  deleteMcpServer,
  listMcpServers,
  startMcpServer,
  stopMcpServer,
  updateMcpServer,
  type CreateMcpServerRequest,
  type McpServer,
  type McpServerDefinition,
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
  url: '',
  auth: 'none',
  enabled: true,
});

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
    refetchInterval: (query) =>
      query.state.data?.some(
        (server) => server.definition.authorizationStatus === 'authorizing',
      )
        ? 2_000
        : false,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<McpServerDefinition | null>(null);
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
        <section className='via-card relative overflow-hidden rounded-2xl border border-sky-200/70 bg-gradient-to-br from-sky-500/[0.12] to-violet-500/[0.10] shadow-sm dark:border-sky-400/15'>
          <div className='pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,hsl(214_90%_60%_/_0.14)_1px,transparent_1px),linear-gradient(to_bottom,hsl(214_90%_60%_/_0.14)_1px,transparent_1px)] [background-size:28px_28px]' />
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
              const location = locationPresentation(serverLocation(server));
              const LocationIcon = location.icon;
              const isPending =
                lifecycle.isPending &&
                lifecycle.variables?.id === server.definition.id;
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
                    </div>
                    <div className='flex items-center justify-between gap-2 border-t pt-3 sm:justify-end sm:border-t-0 sm:pt-0'>
                      <Button
                        variant='outline'
                        size='sm'
                        disabled={isPending || server.status === 'Disabled'}
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
                        {isRunning ? 'Stop' : 'Start'}
                      </Button>
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
          <Empty className='via-card border border-dashed border-sky-200/70 bg-gradient-to-br from-sky-500/[0.06] to-violet-500/[0.05] py-14 dark:border-sky-400/15'>
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
          draft={draft}
          isSaving={save.isPending}
          onOpenChange={(open) => !open && setDraft(null)}
          onSave={(next) => save.mutate(next)}
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
                Workflows that reference its tools will remain unchanged until
                MCP tool selection is added.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={remove.isPending}
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
  isSaving,
  onOpenChange,
  onSave,
}: {
  draft: Draft | null;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: Draft) => void;
}) {
  const [formDraft, setFormDraft] = useState<Draft | null>(draft);
  const [argsText, setArgsText] = useState('');
  useEffect(() => {
    setFormDraft(draft);
    setArgsText(draft?.args.join('\n') ?? '');
  }, [draft]);
  const isOpen = formDraft !== null;
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {formDraft?.id ? 'Edit MCP server' : 'Add MCP server'}
          </DialogTitle>
          <DialogDescription>
            Local servers run on this device. Remote servers connect to an MCP
            endpoint.
          </DialogDescription>
        </DialogHeader>
        {formDraft ? (
          <FieldGroup>
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
            <Field>
              <FieldLabel htmlFor='mcp-server-location'>
                MCP Server type
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
                <SelectTrigger id='mcp-server-location' className='w-full'>
                  <SelectValue placeholder='Select an MCP Server type' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='local'>Local MCP Server</SelectItem>
                  <SelectItem value='remote'>Remote MCP Server</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>
                {formDraft.transport === 'stdio'
                  ? 'Runs a local stdio process managed by Workrun.'
                  : 'Connects to a remote MCP server over Streamable HTTP.'}
              </FieldDescription>
            </Field>
            {formDraft.transport === 'stdio' ? (
              <>
                <Field>
                  <FieldLabel htmlFor='mcp-server-command'>Command</FieldLabel>
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
                  <FieldLabel htmlFor='mcp-server-args'>Arguments</FieldLabel>
                  <Textarea
                    id='mcp-server-args'
                    placeholder={'-y\n@modelcontextprotocol/server-everything'}
                    value={argsText}
                    onChange={(event) => setArgsText(event.target.value)}
                  />
                  <FieldDescription>
                    One command argument per line.
                  </FieldDescription>
                </Field>
              </>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor='mcp-server-url'>Endpoint URL</FieldLabel>
                  <Input
                    id='mcp-server-url'
                    type='url'
                    placeholder='https://example.com/mcp'
                    value={formDraft.url}
                    onChange={(event) =>
                      setFormDraft({ ...formDraft, url: event.target.value })
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
                    <SelectTrigger id='mcp-server-auth' className='w-full'>
                      <SelectValue>
                        {formDraft.auth === 'bearer'
                          ? 'Bearer Token'
                          : formDraft.auth === 'oauth'
                            ? 'OAuth'
                            : 'No authentication'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='none'>No authentication</SelectItem>
                      <SelectItem value='bearer'>Bearer Token</SelectItem>
                      <SelectItem value='oauth'>OAuth</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {formDraft.auth === 'bearer' ? (
                  <Field>
                    <FieldLabel htmlFor='mcp-server-token'>
                      Bearer Token
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
                      Stored encrypted. Leave this field empty to retain the
                      saved token.
                    </FieldDescription>
                  </Field>
                ) : formDraft.auth === 'oauth' ? (
                  <FieldDescription>
                    Save the server, then authorize it in your browser. Workrun
                    stores the resulting credentials encrypted.
                  </FieldDescription>
                ) : null}
              </>
            )}
            <Field orientation='horizontal'>
              <Switch
                id='mcp-server-enabled'
                checked={formDraft.enabled}
                onCheckedChange={(enabled) =>
                  setFormDraft({ ...formDraft, enabled })
                }
              />
              <FieldContent>
                <FieldLabel htmlFor='mcp-server-enabled'>Enabled</FieldLabel>
                <FieldDescription>
                  Disabled servers cannot be started or used by workflows.
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>
        ) : null}
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              isSaving ||
              !formDraft?.name.trim() ||
              (formDraft?.transport === 'stdio'
                ? !formDraft.command.trim()
                : !formDraft.url.trim())
            }
            onClick={() =>
              formDraft &&
              onSave({
                ...formDraft,
                args: argsText
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
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
