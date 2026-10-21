import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { existsSync } from 'fs';
import { ConfigService } from '@nestjs/config';
import { INestApplication, Logger } from '@nestjs/common';
import { AppConfig } from './interfaces/app-config.inteface';
import { configureHttp } from './config/configure-http';

export function resolveProtoPath(): string {
  // Nest CLI copies src/proto to dist/proto; both are relative to this module.
  const protoPath = join(__dirname, 'proto/loyalty/v1/loyalty.proto');
  if (!existsSync(protoPath)) {
    throw new Error(
      'Loyalty protobuf asset is missing; restore src/proto or run bun run build.',
    );
  }
  return protoPath;
}

export async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  let app: INestApplication | undefined;
  let stage = 'dependency creation';
  try {
    app = await NestFactory.create(AppModule, { abortOnError: false });
    const configService = app.get(ConfigService);
    const appConfig = configService.getOrThrow<AppConfig>('app');
    const frontendUrl = configService.get<string>('FRONTEND_URL');
    configureHttp(app, frontendUrl ?? 'http://localhost:3000');

    stage = 'protobuf asset validation (restore src/proto or rebuild dist)';
    const protoPath = resolveProtoPath();
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: { package: 'loyalty.v1', protoPath, url: appConfig.grpcUrl },
    });
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.RMQ,
      options: {
        urls: [appConfig.rmqUrl],
        queue: appConfig.rmqQueue,
        queueOptions: { durable: true },
        noAck: false,
        prefetchCount: configService.getOrThrow<number>('rmqDelivery.prefetch'),
      },
    });

    // Hybrid transports otherwise listen before the application's init/bootstrap
    // hooks (Prisma, schedules and @OnEvent subscriptions) have completed.
    stage = 'application initialization';
    await app.init();
    stage = 'microservice startup';
    await app.startAllMicroservices();
    stage = 'HTTP startup';
    await app.listen(appConfig.port);

    logger.log(`HTTP Server is running on port: ${appConfig.port}`);
    logger.log(`gRPC Microservice is listening on: ${appConfig.grpcUrl}`);
    logger.log(`RMQ Microservice is connected to queue: ${appConfig.rmqQueue}`);
  } catch (error: unknown) {
    // Connection errors can contain credentials; report the controlled phase only.
    logger.error(`Application startup failed during ${stage}.`);
    if (app) {
      try {
        await app.close();
      } catch {
        logger.error('Application cleanup after failed startup failed.');
      }
    }
    throw error;
  }
}

if (require.main === module) {
  void bootstrap().catch(() => {
    process.exit(1);
  });
}
