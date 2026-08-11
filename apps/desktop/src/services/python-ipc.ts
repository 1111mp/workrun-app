import { listen, type UnlistenFn } from '@tauri-apps/api/event';

type IpcMessageEvent = {
  sessionId: string;
  message: unknown;
};

export type PythonUiRequestEvent = {
  runId: string;
  requestId: string;
  schema: unknown;
  uiSchema: unknown;
  title: string | null;
  description: string | null;
};

const IPC_MESSAGE = 'ipc-message';

export function onPythonUiRequest(
  handler: (request: PythonUiRequestEvent) => void,
): Promise<UnlistenFn> {
  return listen<IpcMessageEvent>(IPC_MESSAGE, (event) => {
    const { message, sessionId } = event.payload;
    if (!isPythonUiRequest(message)) return;
    handler({
      runId: sessionId,
      requestId: message.id,
      schema: message.schema ?? null,
      uiSchema: message.uiSchema ?? {},
      title: typeof message.title === 'string' ? message.title : null,
      description:
        typeof message.description === 'string' ? message.description : null,
    });
  });
}

function isPythonUiRequest(
  message: unknown,
): message is Record<string, unknown> & { id: string; type: 'ui.request' } {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>).type === 'ui.request' &&
    typeof (message as Record<string, unknown>).id === 'string'
  );
}
