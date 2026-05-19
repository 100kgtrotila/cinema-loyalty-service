import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { GrpcStatus } from 'src/common/grpc-status';

@Injectable()
export class GrpcApiKeyGuard implements CanActivate {
  private readonly expectedKey: string;

  constructor(private readonly configService: ConfigService) {
    this.expectedKey =
      this.configService.getOrThrow<string>('INTERNAL_API_KEY');
  }

  canActivate(context: ExecutionContext): boolean {
    const metadata: Metadata = context.getArgByIndex(1);
    const keys = metadata.get('x-api-key');
    const apiKey = keys[0] as string | undefined;

    if (!apiKey || apiKey !== this.expectedKey) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Invalid or missing API key',
      });
    }

    return true;
  }
}
