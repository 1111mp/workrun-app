import { Channel, invoke } from '@tauri-apps/api/core';

import { artifactReferences, type ArtifactRef } from '@/services/artifact';
import { validateDeeplinkInput } from '@/services/deeplink';
import type { RunRecord } from '@/services/run-history';
import {
  compileWorkflow,
  getPublishedWorkflow,
  getWorkflow,
  toWorkflowDsl,
  type StoredWorkflow,
} from '@/services/workflow';

export type ModelContent = { role: string; parts: unknown[] };
export type WorkflowCall = {
  workflowId: string;
  input: Record<string, unknown>;
  toolName: string;
  callId?: string;
};
export type AssistantMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  content: ModelContent;
  runId?: string;
  workflowName?: string;
  artifacts?: ArtifactRef[];
  feedback?: 'helpful' | 'unhelpful';
};
export type ActiveWorkflowCall = WorkflowCall & {
  workflow: StoredWorkflow;
  runId?: string;
};
export type AssistantSession = {
  id: string;
  title: string;
  modelId: string;
  messages: AssistantMessage[];
  status: 'idle' | 'thinking' | 'running' | 'needs_input' | 'error';
  activeCall?: ActiveWorkflowCall;
  error?: string;
  steps: number;
};
export type AssistantSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
};
export type AssistantReply = {
  content: ModelContent;
  text: string;
  call?: WorkflowCall;
};

export const listAssistantSessions = () =>
  invoke<AssistantSessionSummary[]>('assistant_session_list');
export const getAssistantSession = (id: string) =>
  invoke<AssistantSession>('assistant_session_get', { id });
export const saveAssistantSession = (session: AssistantSession) =>
  invoke('assistant_session_save', { session });

export function capabilityParameters(settings: WorkflowSettings) {
  const fields = [...settings.inputSchema.fields];
  if (
    settings.mode === 'chat' &&
    !fields.some((field) => field.key === 'input')
  )
    fields.unshift({
      id: 'input',
      key: 'input',
      label: 'Message',
      type: 'textarea',
      required: true,
    });
  return {
    type: 'object',
    properties: Object.fromEntries(
      fields.map((field) => [
        field.key,
        {
          type:
            field.type === 'boolean' || field.type === 'number'
              ? field.type
              : field.type === 'files'
                ? 'array'
                : field.type === 'file'
                  ? 'object'
                  : 'string',
          description: `${field.label}${field.description ? `: ${field.description}` : ''}`,
          ...(field.type === 'files' ? { items: { type: 'object' } } : {}),
        },
      ]),
    ),
    required: fields
      .filter((field) => field.required)
      .map((field) => field.key),
    additionalProperties: false,
  };
}

export type AssistantStreamEvent = {
  type: 'text_delta' | 'text_replace';
  text: string;
};

export function assistantReply(
  session: AssistantSession,
  workflows: StoredWorkflow[],
  onEvent: (event: AssistantStreamEvent) => void,
) {
  const onEventChannel = new Channel<AssistantStreamEvent>();
  onEventChannel.onmessage = onEvent;
  return invoke<AssistantReply>('assistant_reply', {
    onEvent: onEventChannel,
    request: {
      modelId: session.modelId,
      contents: session.messages.map((message) => message.content),
      capabilities: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.document.settings.name,
        description: workflow.document.settings.description,
        parameters: capabilityParameters(workflow.document.settings),
      })),
    },
  });
}

export function missingWorkflowInputs(
  settings: WorkflowSettings,
  input: Record<string, unknown>,
) {
  validateDeeplinkInput(settings, input);
  const fields = [...settings.inputSchema.fields];
  if (
    settings.mode === 'chat' &&
    !fields.some((field) => field.key === 'input')
  )
    fields.push({
      id: 'input',
      key: 'input',
      label: 'Message',
      type: 'textarea',
      required: true,
    });
  return fields.filter((field) => {
    const value = input[field.key];
    return (
      field.required &&
      (value === undefined ||
        value === null ||
        value === '' ||
        (typeof value === 'string' && !value.trim()) ||
        (Array.isArray(value) && value.length === 0))
    );
  });
}

export async function resolveAssistantWorkflow(
  id: string,
  workflows: StoredWorkflow[],
) {
  const candidate = workflows.find((workflow) => workflow.id === id);
  if (!candidate)
    throw new Error('The selected workflow is no longer available.');
  const workflow =
    candidate.editable === false
      ? await getPublishedWorkflow(id)
      : await getWorkflow(id);
  await compileWorkflow(
    toWorkflowDsl(
      workflow.id,
      workflow.document.nodes,
      workflow.document.edges,
      workflow.document.settings,
    ),
  );
  return workflow;
}

export function toolResultContent(
  call: WorkflowCall,
  response: unknown,
): ModelContent {
  // Relay provider call IDs and Gemini thought signatures in the original model
  // content; they must survive the native workflow's asynchronous pause.
  return {
    role: 'user',
    parts: [
      {
        functionResponse: { name: call.toolName, response },
        ...(call.callId ? { id: call.callId } : {}),
      },
    ],
  };
}

export function assistantWorkflowResult(run: RunRecord) {
  // Durable events already contain transport-redacted state. Never forward
  // runtime metadata, raw checkpoints, credentials, or the entire run snapshot.
  const done = [...run.events]
    .reverse()
    .map(({ event }) => event)
    .find((event): event is { type: 'done'; state?: unknown } =>
      Boolean(
        event &&
        typeof event === 'object' &&
        (event as { type?: string }).type === 'done',
      ),
    );
  const result = JSON.stringify(done?.state ?? null);
  return {
    runId: run.id,
    workflow: run.targetName,
    status: run.status,
    error: run.error,
    result: result.slice(0, 24_000),
    truncated: result.length > 24_000,
    artifacts: artifactReferences(done?.state),
  };
}
