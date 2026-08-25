import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

interface NormalResponse<T = unknown> {
  readonly payload?: T;
  readonly errorCode: number;
  readonly message?: string;
}

@Injectable()
export class RespTransformInterceptor<T> implements NestInterceptor<
  T,
  NormalResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<NormalResponse<T>> {
    return next.handle().pipe(map((data) => ({ errorCode: 0, payload: data })));
  }
}
