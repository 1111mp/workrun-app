import { tauriFetchImpl } from '@daveyplate/better-auth-tauri';

import { useWorkrunStore } from '@/stores';

type ApiResponse<T> = {
  errorCode: number;
  message?: string | string[];
  payload?: T;
};

type FetchApiOptions = Omit<RequestInit, 'body' | 'method'>;

/**
 * Calls the configured team API and unwraps its common response envelope.
 *
 * The Tauri fetch implementation is required here so Better Auth's session
 * cookie is sent from the desktop webview rather than treated as a browser
 * cross-origin request.
 */
async function request<T>(
  path: string,
  method: string,
  body?: unknown,
  { headers, ...options }: FetchApiOptions = {},
): Promise<T> {
  const response = await send(path, method, body, headers, options);
  const result = (await response.json()) as ApiResponse<T>;

  if (result.errorCode !== 0) {
    throw new Error(getErrorMessage(result.message, response.status));
  }

  return result.payload as T;
}

async function download(
  path: string,
  { headers, ...options }: FetchApiOptions = {},
): Promise<Blob> {
  const response = await send(path, 'GET', undefined, headers, options);
  return response.blob();
}

async function send(
  path: string,
  method: string,
  body: unknown,
  headers: HeadersInit | undefined,
  options: Omit<FetchApiOptions, 'headers'>,
) {
  const serverUrl = useWorkrunStore.getState().config?.team?.server_url;
  if (!serverUrl) {
    throw new Error('Team server URL is not configured');
  }

  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has('Accept')) {
    requestHeaders.set('Accept', 'application/json');
  }

  if (body !== undefined && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await tauriFetchImpl(`${serverUrl}${normalizePath(path)}`, {
    ...options,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
    headers: requestHeaders,
    method,
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return response;
}

export const fetchApi = {
  get: <T>(path: string, options?: FetchApiOptions) =>
    request<T>(path, 'GET', undefined, options),
  post: <T>(path: string, body?: unknown, options?: FetchApiOptions) =>
    request<T>(path, 'POST', body, options),
  put: <T>(path: string, body?: unknown, options?: FetchApiOptions) =>
    request<T>(path, 'PUT', body, options),
  patch: <T>(path: string, body?: unknown, options?: FetchApiOptions) =>
    request<T>(path, 'PATCH', body, options),
  delete: <T>(path: string, options?: FetchApiOptions) =>
    request<T>(path, 'DELETE', undefined, options),
  // File persistence needs a user-selected path and is handled by the caller.
  download,
};

function normalizePath(path: string) {
  return path.startsWith('/') ? path : `/${path}`;
}

function getErrorMessage(message: ApiResponse<unknown>['message'], status: number) {
  if (Array.isArray(message)) return message.join(', ');
  return message ?? `Request failed with status ${status}`;
}

async function responseError(response: Response) {
  const result = (await response.json().catch(() => undefined)) as
    | ApiResponse<unknown>
    | undefined;
  return new Error(getErrorMessage(result?.message, response.status));
}
