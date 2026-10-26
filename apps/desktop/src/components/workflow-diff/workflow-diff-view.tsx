import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useStore as useFlowStore,
  useNodesInitialized,
  useReactFlow,
  type Node,
} from '@xyflow/react';
import type { TFunction } from 'i18next';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { normalizeWorkflowNodeName } from '@/lib/workflow-node-name';
import { getModelCatalog } from '@/services/cmd';
import type { WorkflowComparison } from '@/services/workflow-revision';
import { useWorkrunStore } from '@/stores';

import {
  diffLines,
  diffWorkflow,
  edgeKey,
  nodeName,
  safeValue,
  type FieldChange,
  type WorkflowChange,
} from './diff';
import {
  NodeDiffContext,
  workflowDiffNodeTypes,
  type NodeDiffDecoration,
} from './workflow-diff-nodes';

function fieldLabel(field: FieldChange, t: TFunction) {
  const path = field.path.replace(/^data\./, '');
  const key =
    path
      .replace(/\[.*?\]/g, '')
      .split('.')
      .at(-1) || 'data';
  return t(`workflowDiff.fields.${key}`, { defaultValue: path });
}
function previewValue(value: unknown, path: string, t: TFunction) {
  const safe = safeValue(value, path);
  if (safe === undefined) return t('workflowDiff.unset');
  if (typeof safe === 'string')
    return path === 'type'
      ? nodeTypeLabel(safe, t)
      : safe || t('workflowDiff.emptyValue');
  if (safe === null || typeof safe === 'number' || typeof safe === 'boolean')
    return JSON.stringify(safe);
  return Array.isArray(safe)
    ? t('workflowDiff.itemCount', { count: safe.length })
    : t('workflowDiff.structuredValue');
}
function ChangePreview({ change }: { change: WorkflowChange }) {
  const { t } = useTranslation();
  const field = change.fields[0];
  if (!field) return null;
  return (
    <span className='flex min-w-0 flex-col gap-1 text-xs font-normal'>
      <span className='text-muted-foreground'>
        {change.fields.map((field) => fieldLabel(field, t)).join(' · ')}
      </span>
      <span className='text-destructive flex gap-1'>
        <span aria-hidden>−</span>
        <span className='line-clamp-2 wrap-anywhere'>
          {previewValue(field.before, field.path, t)}
        </span>
      </span>
      <span className='flex gap-1 text-emerald-600 dark:text-emerald-400'>
        <span aria-hidden>+</span>
        <span className='line-clamp-2 wrap-anywhere'>
          {previewValue(field.after, field.path, t)}
        </span>
      </span>
    </span>
  );
}
function InlineValue({
  value,
  other,
  version,
}: {
  value: string;
  other: string;
  version: 'before' | 'after';
}) {
  let start = 0;
  while (
    start < value.length &&
    start < other.length &&
    value[start] === other[start]
  )
    start++;
  let end = 0;
  while (
    end < value.length - start &&
    end < other.length - start &&
    value[value.length - 1 - end] === other[other.length - 1 - end]
  )
    end++;
  return (
    <>
      {value.slice(0, start)}
      <mark
        className={cn(
          'rounded-sm px-0.5 text-inherit',
          version === 'before' ? 'bg-destructive/20' : 'bg-emerald-500/25',
        )}
      >
        {value.slice(start, value.length - end)}
      </mark>
      {end ? value.slice(-end) : ''}
    </>
  );
}

function nodeTypeLabel(type: string, t: TFunction) {
  const key =
    (
      {
        if_else: 'ifElse',
        human_review: 'humanReview',
        ask_user_question: 'askUserQuestion',
      } as Record<string, string>
    )[type] ?? type;
  return t(`workflowEditor.nodes.${key}`, {
    defaultValue: t(`workflowEditor.palette.items.${type}.label`, {
      defaultValue: type,
    }),
  });
}

function FocusChange({ ids }: { ids: string[] }) {
  const flow = useReactFlow();
  const key = JSON.stringify(ids);
  const initialized = useNodesInitialized();
  const width = useFlowStore((state) => state.width);
  const height = useFlowStore((state) => state.height);
  useEffect(() => {
    if (!initialized || !width || !height) return;
    const selectedIds = JSON.parse(key) as string[];
    // React Flow also observes the container. Fit after its resize is committed,
    // including when the narrow-screen canvas becomes visible again.
    const frame = requestAnimationFrame(
      () =>
        void flow.fitView({
          ...(selectedIds.length
            ? { nodes: selectedIds.map((id) => ({ id })) }
            : {}),
          padding: 0.6,
          maxZoom: 1,
        }),
    );
    return () => cancelAnimationFrame(frame);
  }, [key, flow, initialized, width, height]);
  return null;
}
function FieldDetail({
  field,
  nodeLabels,
}: {
  field: FieldChange;
  nodeLabels: Map<string, string>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const before = safeValue(field.before, field.path),
    after = safeValue(field.after, field.path);
  const lines = useMemo(
    () =>
      typeof before === 'string' &&
      typeof after === 'string' &&
      (before.includes('\n') || after.includes('\n'))
        ? diffLines(before, after)
        : null,
    [before, after],
  );
  const title =
    field.path.replace(/^data\./, '') || t('workflowDiff.fields.data');
  const fieldKey = title
    .replace(/\[.*?\]/g, '')
    .split('.')
    .at(-1)!;
  const { data: models = [] } = useQuery({
    queryKey: ['modelCatalog'],
    queryFn: getModelCatalog,
    enabled: fieldKey === 'modelProfileId',
  });
  const format = (value: unknown): string => {
    if (value === undefined) return t('workflowDiff.unset');
    if (typeof value === 'string') {
      if (fieldKey === 'type') return nodeTypeLabel(value, t);
      if (fieldKey === 'modelProfileId') {
        const model = models.find((model) => model.id === value);
        if (model) return `${model.name} · ${model.model}`;
      }
      if (['source', 'target', 'parentId'].includes(fieldKey))
        return nodeLabels.get(value) ?? value;
      return value || t('workflowDiff.emptyValue');
    }
    if (Array.isArray(value) && ['readers', 'rawReaders'].includes(fieldKey))
      return (
        value
          .map((id) =>
            typeof id === 'string'
              ? (nodeLabels.get(id) ?? id)
              : JSON.stringify(id),
          )
          .join('、') || t('workflowDiff.emptyValue')
      );
    return JSON.stringify(value, null, 2);
  };
  return (
    <section className='flex flex-col gap-2'>
      <h4 className='font-medium'>
        {t(`workflowDiff.fields.${fieldKey}`, { defaultValue: title })}
      </h4>
      {lines ? (
        <div className='overflow-hidden rounded-md border font-mono text-xs'>
          {lines.map((line, index) => {
            const nearChange = lines
              .slice(Math.max(0, index - 3), index + 4)
              .some((item) => item.kind !== 'same');
            if (!expanded && !nearChange) {
              if (
                index > 0 &&
                !lines
                  .slice(Math.max(0, index - 4), index + 3)
                  .some((item) => item.kind !== 'same')
              )
                return null;
              return (
                <div key={index} className='text-muted-foreground px-3 py-1'>
                  …
                </div>
              );
            }
            return (
              <div
                key={index}
                className={cn(
                  'flex gap-3 px-3 py-1 whitespace-pre-wrap wrap-anywhere',
                  line.kind === 'added' && 'bg-emerald-500/10',
                  line.kind === 'removed' && 'bg-destructive/10',
                )}
              >
                <span aria-label={t(`workflowDiff.${line.kind}`)}>
                  {line.kind === 'added'
                    ? '+'
                    : line.kind === 'removed'
                      ? '−'
                      : ' '}
                </span>
                <span>{line.text || ' '}</span>
              </div>
            );
          })}
          <Button
            variant='ghost'
            size='sm'
            onClick={() => setExpanded(!expanded)}
          >
            {t(
              expanded
                ? 'workflowDiff.collapseText'
                : 'workflowDiff.expandText',
            )}
          </Button>
        </div>
      ) : (
        <div className='grid gap-2 sm:grid-cols-2'>
          {(
            [
              ['before', before],
              ['after', after],
            ] as const
          ).map(([version, value]) => (
            <div
              key={version}
              className={cn(
                'min-w-0 rounded-lg border p-3',
                version === 'before'
                  ? 'border-destructive/25 bg-destructive/5'
                  : 'border-emerald-500/30 bg-emerald-500/5',
              )}
            >
              <p
                className={cn(
                  'mb-2 flex items-center gap-2 text-xs font-medium',
                  version === 'before'
                    ? 'text-destructive'
                    : 'text-emerald-600 dark:text-emerald-400',
                )}
              >
                <span aria-hidden>{version === 'before' ? '−' : '+'}</span>
                {t(`workflowDiff.${version}`)}
              </p>
              <div className='max-h-64 overflow-auto text-sm leading-6 wrap-anywhere whitespace-pre-wrap'>
                {typeof before === 'string' && typeof after === 'string' ? (
                  <InlineValue
                    value={format(value)}
                    version={version}
                    other={format(version === 'before' ? after : before)}
                  />
                ) : (
                  format(value)
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
export function WorkflowDiffView({
  comparison,
}: {
  comparison: WorkflowComparison;
}) {
  const { t } = useTranslation();
  const documentRef = useRef<HTMLDivElement>(null);
  const theme = useWorkrunStore((state) => state.resolvedTheme);
  const before = useMemo(
    () =>
      comparison.before ?? {
        nodes: [],
        edges: [],
        settings: comparison.after.settings,
      },
    [comparison],
  );
  const changes = useMemo(
    () => diffWorkflow(before, comparison.after),
    [before, comparison.after],
  );
  const [selectedId, setSelectedId] = useState(changes[0]?.id);
  const [version, setVersion] = useState('after');
  const [view, setView] = useState('changes');
  const [focusRequest, setFocusRequest] = useState<{ id: string }>();
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const selected = changes.find((change) => change.id === selectedId);
  const document = version === 'before' ? before : comparison.after;
  const label = (change: WorkflowChange) =>
    change.kind === 'settings' ? t('workflowDiff.settings') : change.label;
  const select = (change: WorkflowChange) => {
    setSelectedId(change.id);
    setFocusRequest({ id: change.id });
    if (change.status === 'removed') setVersion('before');
    else if (change.status === 'added') setVersion('after');
  };
  const nodeLabels = new Map(
    [...before.nodes, ...comparison.after.nodes].map((node) => [
      node.id,
      nodeName(node),
    ]),
  );
  const nodeChanges = new Map(
    changes
      .filter((change) => change.kind === 'node')
      .map((change) => [change.nodeIds[0], change]),
  );
  // Keep snapshot coordinates, including groups, without using the editor store.
  const absolute = (
    id: string,
    seen = new Set<string>(),
  ): { x: number; y: number } => {
    const node = document.nodes.find((item) => item.id === id);
    if (!node || seen.has(id)) return { x: 0, y: 0 };
    seen.add(id);
    const parent = node.parentId
      ? absolute(node.parentId, seen)
      : { x: 0, y: 0 };
    return { x: node.position.x + parent.x, y: node.position.y + parent.y };
  };
  const decorations = new Map<string, NodeDiffDecoration>(
    [...nodeChanges].map(([id, change]) => [
      id,
      {
        status: change.status,
        label: t(`workflowDiff.${change.status}`),
        fields: change.fields.map((field) => fieldLabel(field, t)).join(' · '),
      },
    ]),
  );
  const nodes: Node[] = document.nodes.map((original) => {
    const node = normalizeWorkflowNodeName(original);
    return {
      id: node.id,
      type: node.type,
      measured: measurements[node.id],
      ...(node.type === 'group'
        ? {
            style: {
              width: node.style?.width ?? 480,
              height: node.style?.height ?? 320,
            },
            zIndex: -1,
          }
        : {}),
      position: absolute(node.id),
      selected: selected?.nodeIds.includes(node.id),
      data: node.data,
    };
  });
  const edges = document.edges.map((edge, index) => {
    const change = changes.find(
      (change) => change.id === `edge:${edgeKey(edge)}`,
    );
    return {
      ...edge,
      id: `review-edge-${index}`,
      selected: selected?.id === change?.id && !!change,
      label: change
        ? `${t(`workflowDiff.${change.status}`)}${edge.sourceHandle ? ` · ${edge.sourceHandle}` : ''}`
        : edge.label,
      style: {
        stroke:
          change?.status === 'removed'
            ? 'var(--destructive)'
            : change?.status === 'added'
              ? '#10b981'
              : 'var(--muted-foreground)',
        strokeWidth: change ? 2 : 1,
        strokeDasharray: change?.status === 'removed' ? '6 4' : undefined,
      },
    };
  });
  const semantic = changes.filter((change) => change.kind !== 'layout');
  const fieldsCount = semantic.reduce(
    (count, change) => count + change.fields.length,
    0,
  );
  const renameOnly =
    semantic.length > 0 &&
    semantic.every(
      (change) =>
        change.kind === 'node' &&
        change.status === 'modified' &&
        change.fields.every((field) =>
          ['data.name', 'data.label'].includes(field.path),
        ),
    );
  useEffect(() => {
    if (view !== 'changes' || !focusRequest) return;
    const element = documentRef.current?.querySelector(
      `[data-change-id="${CSS.escape(focusRequest.id)}"]`,
    );
    element?.scrollIntoView({ block: 'nearest' });
  }, [focusRequest, view]);
  const index = changes.findIndex((change) => change.id === selectedId);
  const navigation = (
    <div className='flex items-center gap-1'>
      <Button
        variant='ghost'
        size='icon-sm'
        aria-label={t('workflowDiff.previous')}
        disabled={index <= 0}
        onClick={() => select(changes[index - 1])}
      >
        <ChevronLeftIcon />
      </Button>
      <span className='text-muted-foreground text-xs'>
        {index + 1}/{changes.length}
      </span>
      <Button
        variant='ghost'
        size='icon-sm'
        aria-label={t('workflowDiff.next')}
        disabled={index >= changes.length - 1}
        onClick={() => select(changes[index + 1])}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
  const changeDetail = (change: WorkflowChange) => (
    <section
      key={change.id}
      data-change-id={change.id}
      className={cn(
        'shrink-0 overflow-hidden rounded-xl border bg-(--workrun-panel)',
        change.id === selectedId && 'border-primary/40',
      )}
    >
      <div className='bg-muted/30 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3'>
        <div className='flex min-w-0 items-center gap-2'>
          <Badge variant='outline'>{t(`workflowDiff.${change.status}`)}</Badge>
          <h3 className='font-medium wrap-anywhere'>{label(change)}</h3>
          <span className='text-muted-foreground text-xs'>
            {t('workflowDiff.fieldCount', { count: change.fields.length })}
          </span>
        </div>
        {view === 'canvas' && navigation}
      </div>
      <div className='flex flex-col gap-5 p-4'>
        {change.fields.map((field) => (
          <FieldDetail
            key={`${change.id}:${field.path}`}
            field={field}
            nodeLabels={nodeLabels}
          />
        ))}
      </div>
    </section>
  );
  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      <div className='bg-muted/20 flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3'>
        <div className='flex flex-col gap-1'>
          <p className='font-medium'>
            {semantic.length
              ? t('workflowDiff.changeSummary', {
                  count: semantic.length,
                  fields: fieldsCount,
                })
              : t(
                  changes.length
                    ? 'workflowDiff.layoutOnly'
                    : 'workflowDiff.noChanges',
                )}
          </p>
          <p className='text-muted-foreground text-xs'>
            {t(
              renameOnly
                ? 'workflowDiff.renameOnly'
                : 'workflowDiff.snapshotNotice',
            )}
          </p>
        </div>
        <div className='flex flex-wrap gap-2'>
          {(['added', 'modified', 'removed'] as const).map((status) => {
            const count = semantic.filter(
              (change) => change.status === status,
            ).length;
            if (!count) return null;
            const Icon =
              status === 'added'
                ? PlusIcon
                : status === 'removed'
                  ? MinusIcon
                  : PencilIcon;
            return (
              <Badge key={status} variant='outline'>
                <Icon data-icon='inline-start' />
                {t(`workflowDiff.${status}`)} {count}
              </Badge>
            );
          })}
        </div>
      </div>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <Tabs value={view} onValueChange={setView}>
          <TabsList aria-label={t('workflowDiff.reviewMode')}>
            <TabsTrigger value='changes'>
              {t('workflowDiff.detailsView')}
            </TabsTrigger>
            <TabsTrigger value='canvas'>
              {t('workflowDiff.canvasView')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {view === 'canvas' ? (
          <Tabs value={version} onValueChange={setVersion}>
            <TabsList aria-label={t('workflowDiff.version')}>
              <TabsTrigger value='before'>
                {t('workflowDiff.before')}
              </TabsTrigger>
              <TabsTrigger value='after'>{t('workflowDiff.after')}</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          changes.length > 0 && navigation
        )}
      </div>
      <div className='grid min-h-0 flex-1 gap-3 md:grid-cols-[17rem_minmax(0,1fr)]'>
        <nav
          aria-label={t('workflowDiff.changes')}
          className='hidden min-h-0 overflow-y-auto rounded-xl border bg-(--workrun-panel) p-2 md:block'
        >
          {(['node', 'edge', 'settings', 'layout'] as const).map((kind) => {
            const items = changes.filter((change) => change.kind === kind);
            if (!items.length) return null;
            const rows = items.map((change) => (
              <Button
                key={change.id}
                variant={change.id === selectedId ? 'secondary' : 'ghost'}
                className='h-auto w-full justify-start py-3 text-left whitespace-normal'
                onClick={() => select(change)}
                aria-pressed={change.id === selectedId}
              >
                <span className='flex min-w-0 flex-col gap-2'>
                  <span className='font-medium wrap-anywhere'>
                    {label(change)}
                  </span>
                  <ChangePreview change={change} />
                </span>
              </Button>
            ));
            return kind === 'layout' ? (
              <details key={kind}>
                <summary className='cursor-pointer p-2 text-xs'>
                  {t('workflowDiff.layout')} ({items.length})
                </summary>
                {rows}
              </details>
            ) : (
              <div key={kind} className='mb-2'>
                <p className='text-muted-foreground px-2 py-2 text-xs'>
                  {t(`workflowDiff.${kind}`)} ({items.length})
                </p>
                {rows}
              </div>
            );
          })}
        </nav>
        {view === 'changes' ? (
          <div
            ref={documentRef}
            role='region'
            aria-label={t('workflowDiff.detailsView')}
            className='flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto pr-1 pb-2'
          >
            {semantic.map(changeDetail)}
            {changes.some((change) => change.kind === 'layout') && (
              <details open={!semantic.length}>
                <summary className='cursor-pointer p-2 text-sm'>
                  {t('workflowDiff.layout')}
                </summary>
                <div className='flex flex-col gap-4'>
                  {changes
                    .filter((change) => change.kind === 'layout')
                    .map(changeDetail)}
                </div>
              </details>
            )}
            {!changes.length && (
              <p className='text-muted-foreground p-4'>
                {t('workflowDiff.noChanges')}
              </p>
            )}
          </div>
        ) : (
          <div className='flex min-h-0 min-w-0 flex-col gap-3 xl:flex-row'>
            <div className='workrun-editor relative min-h-56 min-w-0 flex-1 overflow-hidden rounded-xl border'>
              <NodeDiffContext.Provider value={decorations}>
                <ReactFlowProvider>
                  <ReactFlow
                    colorMode={theme}
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={workflowDiffNodeTypes}
                    fitView
                    onNodesChange={(updates) => {
                      // Controlled read-only nodes still need to retain React Flow's
                      // measurements so fitView can wait for a fully measured graph.
                      const dimensions = updates.filter(
                        (update) =>
                          update.type === 'dimensions' && update.dimensions,
                      );
                      if (!dimensions.length) return;
                      setMeasurements((current) => {
                        const next = { ...current };
                        let changed = false;
                        for (const update of dimensions)
                          if (
                            update.type === 'dimensions' &&
                            update.dimensions &&
                            (next[update.id]?.width !==
                              update.dimensions.width ||
                              next[update.id]?.height !==
                                update.dimensions.height)
                          ) {
                            next[update.id] = update.dimensions;
                            changed = true;
                          }
                        return changed ? next : current;
                      });
                    }}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    deleteKeyCode={null}
                    onNodeClick={(_, node) => {
                      const change =
                        changes.find(
                          (change) =>
                            change.kind === 'node' &&
                            change.nodeIds.includes(node.id),
                        ) ??
                        changes.find((change) =>
                          change.nodeIds.includes(node.id),
                        );
                      if (change) select(change);
                    }}
                    onEdgeClick={(_, edge) => {
                      const original =
                        document.edges[
                          Number(edge.id.replace('review-edge-', ''))
                        ];
                      const change = changes.find(
                        (change) => change.id === `edge:${edgeKey(original)}`,
                      );
                      if (change) select(change);
                    }}
                  >
                    <Background
                      gap={24}
                      size={1}
                      color='var(--workrun-canvas-dot)'
                    />
                    <Controls showInteractive={false} />
                    <FocusChange
                      ids={(selected?.nodeIds ?? []).filter((id) =>
                        document.nodes.some((node) => node.id === id),
                      )}
                    />
                  </ReactFlow>
                </ReactFlowProvider>
              </NodeDiffContext.Provider>
            </div>
            {selected && (
              <div className='max-h-[40vh] min-h-0 min-w-0 overflow-y-auto xl:max-h-none xl:w-80'>
                {changeDetail(selected)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
