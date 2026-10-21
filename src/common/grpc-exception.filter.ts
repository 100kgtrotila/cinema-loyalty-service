import { Catch, Logger, RpcExceptionFilter } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Observable, throwError } from 'rxjs';
import { GrpcStatus } from './grpc-status';

// Controller-scoped: HTTP and RMQ retain their independent exception/delivery policies.
@Catch()
export class GrpcExceptionFilter implements RpcExceptionFilter<unknown, never> {
  private readonly logger = new Logger(GrpcExceptionFilter.name);

  catch(exception: unknown): Observable<never> {
    if (exception instanceof RpcException) {
      const error = exception.getError();
      return throwError(() =>
        typeof error === 'string' ? { status: 'error', message: error } : error,
      );
    }
    // Prisma/connection exceptions may embed SQL arguments, credentials or payloads.
    this.logger.error('operation=grpc code=INTERNAL');
    return throwError(() => ({
      code: GrpcStatus.INTERNAL,
      message: 'Internal server error',
    }));
  }
}
