import { listen } from '@tauri-apps/api/event';
import type { Node } from '@xyflow/react';
import {
  Badge,
  Button,
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  ScrollArea,
} from '@workspace/ui/components';
import { PinIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  AppRunOutputPanel,
  restoreProcessNodeRun,
} from '@/components/app-run-output-panel';
import { WorkflowRunOutput } from '@/components/workflow-output-panel';
import {
  inspectRunRecord,
  type RunRecord,
  type RunStatus,
} from '@/services/run-history';
import type { WorkflowRunEvent } from '@/services/workflow';
import { useRunWorkspaceStore } from '@/stores/run-workspace.store';
import { replayWorkflowRunView } from '@/stores/workflow-run.store';

function workflowSnapshot(snapshot: unknown): {
  mode: 'task' | 'chat';
  nodes: Node[];
} {
  if (!snapshot || typeof snapshot !== 'object') {
    return { mode: 'task', nodes: [] };
  }
  const { nodes, settings } = snapshot as Record<string, unknown>;
  const mode =
    settings &&
    typeof settings === 'object' &&
    (settings as Record<string, unknown>).mode === 'chat'
      ? 'chat'
      : 'task';
  return { mode, nodes: Array.isArray(nodes) ? (nodes as Node[]) : [] };
}

const statusTone: Record<RunStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-sky-600 dark:text-sky-400',
  waiting_for_input: 'text-amber-600 dark:text-amber-400',
  completed: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  interrupted: 'text-amber-600 dark:text-amber-400',
};

function RunWorkspace() {
  const {
    tabs,
    activeRunId,
    open,
    focusRun,
    closeRun,
    togglePinned,
    noteEvent,
    setOpen,
  } = useRunWorkspaceStore();
  const activeTab = tabs.find((tab) => tab.id === activeRunId);
  const [record, setRecord] = useState<RunRecord>();
  // Keep the previous response while a new tab loads, but never render it for
  // a different run. This avoids a synchronous effect update just to clear UI.
  const activeRecord = record?.id === activeRunId ? record : undefined;
  const workflowRun = useMemo(() => {
    if (activeTab?.targetType !== 'workflow' || !activeRecord) return;
    const snapshot = workflowSnapshot(activeRecord.targetSnapshot);
    const run = replayWorkflowRunView(
      activeRecord.outputView,
      activeRecord.events.map(({ event }) => event as WorkflowRunEvent),
      snapshot,
    );
    const startedAt = Date.parse(activeRecord.startedAt);
    const endedAt =
      !Number.isNaN(startedAt) && activeRecord.durationMs !== undefined
        ? startedAt + activeRecord.durationMs
        : activeRecord.endedAt
          ? Date.parse(activeRecord.endedAt)
          : undefined;
    const terminalState =
      activeRecord.status === 'completed' ||
      activeRecord.status === 'failed' ||
      activeRecord.status === 'cancelled' ||
      activeRecord.status === 'interrupted'
        ? {
            status: activeRecord.status,
            error:
              activeRecord.status === 'cancelled'
                ? undefined
                : activeRecord.error,
          }
        : undefined;
    return {
      ...snapshot,
      // The archived duration is authoritative. It remains stable even if the
      // output panel is reopened long after a terminal event was received.
      run: {
        ...run,
        ...terminalState,
        durationMs: activeRecord.durationMs,
        startedAt: Number.isNaN(startedAt) ? run.startedAt : startedAt,
        endedAt:
          endedAt === undefined || Number.isNaN(endedAt) ? run.endedAt : endedAt,
      },
    };
  }, [activeRecord, activeTab?.targetType]);

  useEffect(() => {
    if (!activeRunId || !open) return;
    let cancelled = false;
    void inspectRunRecord(activeRunId).then((next) => {
      if (!cancelled) setRecord(next);
    });
    return () => {
      cancelled = true;
    };
  }, [activeRunId, open]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenStatusChange: (() => void) | undefined;
    const refreshActiveRun = (runId: string) => {
      if (runId !== useRunWorkspaceStore.getState().activeRunId) return;
      void inspectRunRecord(runId).then(setRecord);
    };
    void listen<{ runId: string }>('run-event', ({ payload }) => {
      noteEvent(payload.runId);
      refreshActiveRun(payload.runId);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    void listen<{ runId: string }>('run-status-changed', ({ payload }) => {
      refreshActiveRun(payload.runId);
    }).then((stop) => {
      if (disposed) stop();
      else unlistenStatusChange = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      unlistenStatusChange?.();
    };
  }, [noteEvent]);

  if (activeTab?.targetType === 'app') {
    // Wait for the saved output before mounting the drawer so Vaul can measure
    // its final content rather than animate an empty sheet from the viewport.
    return (
      <AppRunOutputPanel
        open={open && Boolean(activeRecord)}
        readOnly
        run={activeRecord ? restoreProcessNodeRun(activeRecord) : undefined}
        onClear={() => undefined}
        onRunAgain={() => undefined}
        onOpenChange={setOpen}
      />
    );
  }

  if (activeTab?.targetType === 'workflow' && workflowRun) {
    return (
      <Drawer
        open={open}
        showSwipeHandle
        snapPoints={['31rem', 1]}
        onOpenChange={setOpen}
      >
        <DrawerContent>
          <WorkflowRunOutput
            readOnly
            isChat={workflowRun.mode === 'chat'}
            isRunning={workflowRun.run.status === 'running'}
            run={workflowRun.run}
            workflowNodes={workflowRun.nodes}
            onClose={() => setOpen(false)}
            onRunAgain={() => undefined}
          />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Drawer
      open={open}
      showSwipeHandle
      onOpenChange={setOpen}
      snapPoints={['31rem', 1]}
    >
      <DrawerContent>
        <DrawerHeader className='border-b px-5 py-3 text-left'>
          <DrawerTitle className='text-base'>Run workspace</DrawerTitle>
        </DrawerHeader>
        <div className='bg-muted/25 border-b px-3 py-2'>
          <div className='flex gap-1 overflow-x-auto'>
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`group flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs ${tab.id === activeRunId ? 'bg-background shadow-xs' : 'bg-transparent'}`}
              >
                <button
                  className='flex items-center gap-1.5'
                  type='button'
                  onClick={() => focusRun(tab.id)}
                >
                  <span
                    className={`size-1.5 rounded-full ${statusTone[tab.status]}`}
                  />
                  <span className='max-w-36 truncate'>{tab.targetName}</span>
                  {tab.unreadEvents > 0 ? (
                    <Badge className='h-4 min-w-4 px-1 text-[10px]'>
                      {tab.unreadEvents}
                    </Badge>
                  ) : null}
                </button>
                {tab.pinned ? <PinIcon className='size-3' /> : null}
                <button
                  aria-label={`Close ${tab.targetName}`}
                  className='text-muted-foreground hover:text-foreground'
                  type='button'
                  onClick={() => closeRun(tab.id)}
                >
                  <XIcon className='size-3' />
                </button>
              </div>
            ))}
          </div>
        </div>
        <ScrollArea className='min-h-0 flex-1'>
          {activeTab && activeRecord ? (
            <div className='mx-auto max-w-4xl space-y-4 p-5'>
              <div className='flex items-start justify-between gap-4'>
                <div>
                  <p className='text-muted-foreground text-xs font-medium tracking-wide uppercase'>
                    {activeTab.targetType}
                  </p>
                  <h2 className='mt-1 text-lg font-semibold'>
                    {activeTab.targetName}
                  </h2>
                  <p className='text-muted-foreground mt-1 text-xs'>
                    {new Date(activeRecord.startedAt).toLocaleString()} ·{' '}
                    {activeRecord.status}
                  </p>
                </div>
                <Button
                  size='sm'
                  variant={activeTab.pinned ? 'secondary' : 'outline'}
                  onClick={() => togglePinned(activeTab.id)}
                >
                  <PinIcon /> {activeTab.pinned ? 'Pinned' : 'Pin'}
                </Button>
              </div>
              <section className='bg-muted/15 rounded-lg border'>
                <div className='border-b px-4 py-2 text-xs font-medium'>
                  Event journal · {activeRecord.events.length}
                </div>
                <div className='divide-y'>
                  {activeRecord.events.map((event) => (
                    <pre
                      key={event.sequence}
                      className='overflow-x-auto p-3 text-xs leading-5'
                    >
                      {JSON.stringify(event.event, null, 2)}
                    </pre>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            <div className='text-muted-foreground p-6 text-sm'>
              Select a run to replay its recorded events.
            </div>
          )}
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  );
}

export { RunWorkspace };
