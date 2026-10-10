import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { artifactReferences } from '@/services/artifact';

export type LinkRequest = {
  targetType: 'apps' | 'workflows';
  targetId: string;
  action: 'open' | 'run';
  input: Record<string, unknown>;
  requestId?: string;
};

export type IncomingLink = {
  id: string;
  request?: LinkRequest;
  error?: string;
  runId?: string;
};

// Both a newly accepted link and a deduplicated request must open the same
// execution view without routing through an App detail or the Runs workspace.
export function deeplinkRunPath(
  targetType: LinkRequest['targetType'],
  targetId: string,
  runId: string,
) {
  const query = `runId=${encodeURIComponent(runId)}`;
  return targetType === 'apps'
    ? `/apps?${query}`
    : `/workflows/${encodeURIComponent(targetId)}?${query}&live=true`;
}

export function createDeeplink(
  targetType: LinkRequest['targetType'],
  targetId: string,
  action: LinkRequest['action'],
  input?: Record<string, unknown>,
  requestId?: string,
) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(targetId))
    throw new Error('Invalid target ID');
  if (
    (action === 'open' && (input || requestId)) ||
    (targetType === 'apps' && input)
  )
    throw new Error('Input is supported only for Workflow run links');
  const url = new URL(
    `workrun://v1/${targetType}/${encodeURIComponent(targetId)}${action === 'run' ? '/run' : ''}`,
  );
  if (input && Object.keys(input).length)
    url.searchParams.set('input', JSON.stringify(input));
  if (requestId) url.searchParams.set('requestId', requestId);
  if (url.toString().length > 32_768)
    throw new Error('Workrun link exceeds 32 KB');
  return url.toString();
}

/** Validate supplied values without rejecting missing fields that the form can fill. */
export function validateDeeplinkInput(
  settings: WorkflowSettings,
  input: Record<string, unknown>,
) {
  const isFile = (value: unknown) =>
    Boolean(
      value &&
      typeof value === 'object' &&
      '$type' in value &&
      value.$type === 'artifact' &&
      artifactReferences(value).length === 1,
    );
  for (const [key, value] of Object.entries(input)) {
    const field = settings.inputSchema.fields.find(
      (field) => field.key === key,
    );
    const type =
      settings.mode === 'chat' && key === 'input' ? 'text' : field?.type;
    if (!type) throw new Error(`Unknown Workflow input: ${key}`);
    const valid =
      type === 'boolean'
        ? typeof value === 'boolean'
        : type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : type === 'file'
            ? isFile(value)
            : type === 'files'
              ? Array.isArray(value) && value.every(isFile)
              : typeof value === 'string';
    if (!valid) throw new Error(`Invalid ${type} input: ${key}`);
  }
}

type DeeplinkUpdate = { revision: number; pending: IncomingLink | null };

export async function subscribeDeeplinks(
  onRequest: (request: IncomingLink | null) => void,
): Promise<UnlistenFn> {
  let revision = -1;
  const apply = (update: DeeplinkUpdate) => {
    // Startup synchronization and live events may arrive in either order.
    if (update.revision <= revision) return;
    revision = update.revision;
    onRequest(update.pending);
  };
  const unlisten = await listen<DeeplinkUpdate>(
    'deeplink-request',
    ({ payload }) => apply(payload),
  );
  try {
    // Subscribe first, then recover links received before the webview mounted.
    apply(await invoke<DeeplinkUpdate>('deeplink_snapshot'));
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
}

export const dismissDeeplink = (id: string) =>
  invoke('deeplink_dismiss', { id });

export function submitDeeplink(
  id: string,
  kind: 'app' | 'workflow',
  request: unknown,
) {
  return invoke<string>('deeplink_submit', {
    id,
    execution: { kind, request },
  });
}
