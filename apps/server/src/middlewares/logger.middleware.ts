import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  constructor(private readonly logger: Logger) {}

  use(req: Request, res: Response, next: NextFunction) {
    req.startTime = Date.now();
    this.logger.log(
      `${process.pid} ${req.method} ${req.originalUrl} ${req.ip}`,
    );

    res.on('finish', () => {
      const user = req.user
        ? `${req.user.email ?? req.user.name}`
        : 'anonymous';
      this.logger.log(
        `${process.pid} ${req.method} ${res.statusCode} ${req.originalUrl} ${Date.now() - req.startTime}ms ${user}`,
      );
    });

    next();
  }
}
