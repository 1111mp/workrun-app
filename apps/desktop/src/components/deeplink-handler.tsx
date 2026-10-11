import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from '@workspace/ui/components';
import { CircleAlertIcon, LinkIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { WorkflowRunForm } from '@/components/workflow-run-panel';
import {
  deeplinkRunPath,
  dismissDeeplink,
  subscribeDeeplinks,
  submitDeeplink,
  validateDeeplinkInput,
  type IncomingLink,
} from '@/services/deeplink';
import {
  getProcessNode,
  prepareWorkflowProcessApps,
} from '@/services/process-node';
import { inspectRunRecord } from '@/services/run-history';
import {
  compileWorkflow,
  getWorkflow,
  toWorkflowDsl,
} from '@/services/workflow';

export function DeeplinkHandler() {
  const [incoming, setIncoming] = useState<IncomingLink>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [settledRevision, setSettledRevision] = useState(0);
  const processing = useRef(false);
  const dismissedId = useRef<string | undefined>(undefined);
  const lastIncomingId = useRef<string | undefined>(undefined);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const link = incoming?.request;
  const app = useQuery({
    queryKey: ['deeplink-app', incoming?.id],
    queryFn: () => getProcessNode(link!.targetId),
    enabled:
      link?.targetType === 'apps' && !incoming?.runId && !incoming?.error,
    retry: false,
  });
  const workflow = useQuery({
    queryKey: ['deeplink-workflow', incoming?.id],
    queryFn: () => getWorkflow(link!.targetId),
    enabled:
      link?.targetType === 'workflows' && !incoming?.runId && !incoming?.error,
    retry: false,
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeDeeplinks((received) => {
      if (disposed) return;
      const next = received?.id === dismissedId.current ? null : received;
      if (lastIncomingId.current !== next?.id) {
        lastIncomingId.current = next?.id;
        setError(undefined);
      }
      setIncoming((current) =>
        current?.id === next?.id &&
        current?.error === next?.error &&
        current?.runId === next?.runId
          ? current
          : (next ?? undefined),
      );
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((cause) => {
        if (!disposed)
          toast.error(t('deeplink.errorTitle'), {
            toasterId: 'global',
            description: String(cause),
          });
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [t]);

  const confirmationPath =
    link?.action === 'run' && !incoming?.runId && !incoming?.error
      ? `/${link.targetType}`
      : undefined;

  useEffect(() => {
    if (!confirmationPath || processing.current) return;
    // Establish the list page before showing confirmation, including links
    // received on startup or while another target's detail page is open.
    void navigate(confirmationPath, { replace: true });
  }, [incoming?.id, confirmationPath, navigate]);

  const close = async () => {
    if (!incoming || processing.current) return;
    await dismissDeeplink(incoming.id);
    dismissedId.current = incoming.id;
    setIncoming((current) =>
      current?.id === incoming.id ? undefined : current,
    );
  };

  useEffect(() => {
    if (
      !incoming ||
      !link ||
      (link.action !== 'open' && !incoming.runId) ||
      incoming.error ||
      error ||
      incoming.id === dismissedId.current ||
      processing.current
    )
      return;
    if (!(app.data || workflow.data || incoming.runId)) return;
    processing.current = true;
    void (async () => {
      if (incoming.runId) {
        const record = await inspectRunRecord(incoming.runId);
        await navigate(
          deeplinkRunPath(
            record.targetType === 'app' ? 'apps' : 'workflows',
            record.targetId,
            record.id,
          ),
        );
      } else {
        await navigate(
          `/${link.targetType}/${encodeURIComponent(link.targetId)}`,
        );
      }
      await dismissDeeplink(incoming.id);
      dismissedId.current = incoming.id;
      setIncoming((current) =>
        current?.id === incoming.id ? undefined : current,
      );
    })()
      .catch((cause) => setError(String(cause)))
      .finally(() => {
        processing.current = false;
        setSettledRevision((revision) => revision + 1);
      });
  }, [
    incoming,
    link,
    app.data,
    workflow.data,
    navigate,
    settledRevision,
    error,
  ]);

  const run = async (input: Record<string, unknown> = {}) => {
    if (!incoming || !link || processing.current) return;
    processing.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      let runId: string;
      if (app.data) {
        if (
          app.data.installStatus !== 'installed' &&
          app.data.installStatus !== 'updateAvailable'
        )
          throw new Error(t('deeplink.notInstalled'));
        runId = await submitDeeplink(incoming.id, 'app', {
          runId: incoming.id,
          targetId: link.targetId,
          targetName: app.data.definition.name,
          targetSnapshot: app.data.definition,
          outputView: { isRunning: true, node: app.data },
        });
      } else if (workflow.data) {
        const { document, releaseId, version } = workflow.data;
        const { nodes, edges, settings } = document;
        const dsl = await prepareWorkflowProcessApps(
          toWorkflowDsl(link.targetId, nodes, edges, settings),
          `release-${releaseId ?? `draft-${link.targetId}`}`,
          undefined,
          { allowInstall: false },
        );
        await compileWorkflow(dsl);
        runId = await submitDeeplink(incoming.id, 'workflow', {
          runId: incoming.id,
          targetId: link.targetId,
          targetName: settings.name,
          input,
          initialState: input,
          targetSnapshot: document,
          dsl,
          releaseId,
          releaseVersion: version,
          threadId: crypto.randomUUID(),
        });
      } else return;
      await navigate(deeplinkRunPath(link.targetType, link.targetId, runId));
      await dismissDeeplink(incoming.id);
      dismissedId.current = incoming.id;
      setIncoming((current) =>
        current?.id === incoming.id ? undefined : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      processing.current = false;
      setSubmitting(false);
      setSettledRevision((revision) => revision + 1);
    }
  };

  const targetError = app.error ?? workflow.error;
  let inputError: string | undefined;
  if (workflow.data && link) {
    try {
      validateDeeplinkInput(workflow.data.document.settings, link.input);
    } catch (cause) {
      inputError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const message =
    incoming?.error ??
    inputError ??
    error ??
    (targetError ? targetError.message : undefined);
  const name =
    app.data?.definition.name ?? workflow.data?.document.settings.name;
  return (
    <Dialog
      open={
        Boolean(incoming) &&
        (!confirmationPath || pathname === confirmationPath) &&
        (link?.action === 'run' || Boolean(message))
      }
      onOpenChange={(open) => {
        if (!open && !submitting) void close();
      }}
    >
      <DialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-3xl! gap-0 overflow-y-auto p-0'>
        <div className='via-background from-primary/12 to-muted/50 relative overflow-hidden border-b bg-linear-to-br px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
          <div className='bg-primary/10 absolute -top-12 -right-10 size-36 rounded-full blur-2xl' />
          <DialogHeader className='relative flex-row items-start gap-3 text-left'>
            <span className='border-primary/20 bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl border shadow-sm'>
              <LinkIcon className='size-5' />
            </span>
            <div className='flex min-w-0 flex-col gap-1.5 pr-6'>
              <DialogTitle className='text-lg font-semibold tracking-tight'>
                {t(
                  incoming?.error || targetError
                    ? 'deeplink.errorTitle'
                    : 'deeplink.confirmTitle',
                  {
                    name: name ?? 'Workrun',
                  },
                )}
              </DialogTitle>
              <DialogDescription className='text-sm leading-5'>
                {t('deeplink.confirmDescription')}
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>
        <div className='flex flex-col gap-4 px-5 py-5 sm:px-6'>
          {name && link ? (
            <p className='text-muted-foreground text-sm break-all'>
              {link.targetType === 'apps' ? 'App' : 'Workflow'} · {name}
              {app.data?.definition.version || workflow.data?.version
                ? ` · v${app.data?.definition.version ?? workflow.data?.version}`
                : ''}
            </p>
          ) : null}
          {message ? (
            <Alert variant='destructive'>
              <CircleAlertIcon />
              <AlertDescription className='wrap-break-word'>
                {message}
              </AlertDescription>
            </Alert>
          ) : null}
          {!message && !name ? <Spinner /> : null}
        </div>
        {workflow.data &&
        !incoming?.error &&
        !inputError &&
        link?.action === 'run' ? (
          <WorkflowRunForm
            key={incoming!.id}
            layout='dialog'
            settings={workflow.data.document.settings}
            initialInput={link.input}
            isRunning={submitting}
            onClose={() => void close()}
            onRun={(input) => void run(input)}
          />
        ) : (
          <DialogFooter className='bg-muted/15 border-t px-5 py-4 sm:px-6'>
            <Button
              variant='outline'
              disabled={submitting}
              onClick={() => void close()}
            >
              {t('apps.new.cancel')}
            </Button>
            {app.data && !incoming?.error ? (
              <Button disabled={submitting} onClick={() => void run()}>
                {submitting ? <Spinner /> : null}
                {t('workflows.run')}
              </Button>
            ) : null}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
