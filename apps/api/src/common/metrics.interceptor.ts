import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { httpServerDuration } from '@ticketing/otel';
import type { Request, Response } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';

/**
 * RED metrics for every endpoint, from one histogram.
 *
 * The route label is the *route template* the router matched (`/events/:slug`),
 * never `req.path`. Labelling by raw path would create a new Prometheus time
 * series per event id and per order id, and would take the metrics store down
 * long before the application itself struggled.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { route?: { path?: string } }>();
    const response = http.getResponse<Response>();
    const start = process.hrtime.bigint();

    const record = (statusCode: number) => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      httpServerDuration.record(durationMs, {
        'http.request.method': request.method,
        'http.route': request.route?.path ?? 'unmatched',
        'http.response.status_code': statusCode,
        'error.type': statusCode >= 500 ? 'server' : statusCode >= 400 ? 'client' : 'none',
      });
    };

    return next.handle().pipe(
      tap(() => record(response.statusCode)),
      catchError((err) => {
        record(typeof err?.status === 'number' ? err.status : 500);
        return throwError(() => err);
      }),
    );
  }
}
