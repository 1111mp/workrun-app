import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { isLlmPath, llmErrorBody } from '../modules/llm/llm-error';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const resp = ctx.getResponse<Response>();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    if (isLlmPath(req.path)) {
      // Guard/body-parser errors must use the same protocol as model errors.
      // A started SSE stream cannot be replaced with a JSON error response.
      this.logger.error(`${req.method} ${req.path} ${statusCode}`);
      if (resp.headersSent) {
        resp.destroy();
        return;
      }
      return resp.status(statusCode).json(llmErrorBody(exception, statusCode));
    }
    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : typeof exception === 'string'
          ? exception
          : exception.message;

    this.logger.error(`${req.method} ${req.originalUrl} ${message}`);

    return resp.status(statusCode).json({
      errorCode: statusCode,
      message,
    });
  }
}
