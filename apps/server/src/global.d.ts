import type { UserSession } from '@thallesp/nestjs-better-auth';

declare global {
  namespace Express {
    interface Request {
      startTime: number;
      session?: UserSession;
      user?: UserSession['user'];
    }
  }
}

export {};
