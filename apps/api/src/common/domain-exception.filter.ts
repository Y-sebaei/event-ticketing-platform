import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { DomainError } from '@ticketing/domain';
import { currentTraceId } from '@ticketing/otel';
import type { Response } from 'express';

/**
 * One place that turns an error into an HTTP response.
 *
 * Every response carries the trace id. That single field is what turns a
 * customer saying "it failed" into a Grafana link, and it is why the README's
 * trace section can be three commands long.
 */
const STATUS_BY_CODE: Record<string, HttpStatus> = {
  INVALID_QUANTITY: HttpStatus.BAD_REQUEST,
  ORDER_TOO_LARGE: HttpStatus.BAD_REQUEST,
  INVALID_IDEMPOTENCY_KEY: HttpStatus.BAD_REQUEST,
  SALES_WINDOW_CLOSED: HttpStatus.CONFLICT,
  INSUFFICIENT_INVENTORY: HttpStatus.CONFLICT,
  ILLEGAL_TRANSITION: HttpStatus.CONFLICT,
  INVARIANT_VIOLATION: HttpStatus.INTERNAL_SERVER_ERROR,
};

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = currentTraceId();

    if (exception instanceof DomainError) {
      const status = STATUS_BY_CODE[exception.code] ?? HttpStatus.BAD_REQUEST;
      response.status(status).json({
        error: exception.code,
        message: exception.message,
        details: exception.details,
        traceId,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      response
        .status(status)
        .json(
          typeof payload === 'string'
            ? { error: exception.name, message: payload, traceId }
            : { ...(payload as object), traceId },
        );
      return;
    }

    // Unexpected: log with the trace id so the log line and the trace can be
    // joined, and tell the client nothing beyond the id.
    this.logger.error(`unhandled error (trace ${traceId ?? 'none'})`, (exception as Error)?.stack);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: 'INTERNAL',
      message: 'Something went wrong on our side.',
      traceId,
    });
  }
}
