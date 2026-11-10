import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export const OPENAI_RESPONSE = 'workrun:openai-response';

interface NormalResponse<T = unknown> {
  readonly payload?: T;
  readonly errorCode: number;
  readonly message?: string;
}

@Injectable()
export class RespTransformInterceptor<T> implements NestInterceptor<
  T,
  NormalResponse<T> | T
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<NormalResponse<T> | T> {
    if (
      Reflect.getMetadata(OPENAI_RESPONSE, context.getHandler()) ||
      Reflect.getMetadata(OPENAI_RESPONSE, context.getClass())
    ) {
      return next.handle();
    }
    return next.handle().pipe(map((data) => ({ errorCode: 0, payload: data })));
  }
}
