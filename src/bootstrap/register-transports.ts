import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import type { RuntimeConfiguration } from '../config/app.config';
import type { AppConfig } from '../interfaces/app-config.inteface';

export function registerTransports(
  app: INestApplication,
  appConfig: AppConfig,
  configService: ConfigService<RuntimeConfiguration>,
  protoPath: string,
): void {
  // HTTP global validation is intentionally not inherited. gRPC controllers
  // use RPC pipes/filters; RMQ validates inside its durable delivery handler.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: { package: 'loyalty.v1', protoPath, url: appConfig.grpcUrl },
  });
  const prefetchCount = configService.getOrThrow('rmqDelivery.prefetch', {
    infer: true,
  });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [appConfig.rmqUrl],
      queue: appConfig.rmqQueue,
      queueOptions: { durable: true },
      noAck: false,
      prefetchCount,
    },
  });
}
