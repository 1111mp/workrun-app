import { HttpException } from '@nestjs/common';

export class LlmError extends HttpException {
  constructor(status: number, message: string, type: string, code: string) {
    super({ error: { message, type, param: null, code } }, status);
  }
}

export function isLlmPath(path: string): boolean {
  return path === '/api/v1/llm' || path.startsWith('/api/v1/llm/');
}

export function llmErrorBody(exception: unknown, status: number) {
  if (exception instanceof LlmError) return exception.getResponse();
  // Authentication guards and JSON/body-parser failures also need the protocol
  // envelope. Do not expose arbitrary exception messages or upstream bodies.
  const message =
    status === 401
      ? 'Sign in to use team models.'
      : status === 403
        ? 'Access to team models was denied.'
        : status === 413
          ? 'The model request is too large.'
          : status === 400
            ? 'Invalid model request.'
            : status === 404
              ? 'Model endpoint not found.'
              : 'The model service is unavailable.';
  return {
    error: {
      message,
      type:
        status === 401
          ? 'authentication_error'
          : status === 403
            ? 'permission_error'
            : status < 500
              ? 'invalid_request_error'
              : 'server_error',
      param: null,
      code: String(status),
    },
  };
}
