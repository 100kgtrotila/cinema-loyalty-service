import type { RuntimeConfiguration } from '../config/app.config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ConfigService } from '@nestjs/config';
import { INestApplication, Logger } from '@nestjs/common';
import { configureHttp } from '../config/configure-http';
import { registerTransports } from './register-transports';
import { resolveProtoPath } from './resolve-proto-path';

export async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  let app: INestApplication | undefined;
  let stage = 'dependency creation';
  try {
    app = await NestFactory.create(AppModule, { abortOnError: false });
    const configService =
      app.get<ConfigService<RuntimeConfiguration>>(ConfigService);
    const appConfig = configService.getOrThrow('app', { infer: true });
    const frontendUrl = configService.getOrThrow('FRONTEND_URL', {
      infer: true,
    });
    configureHttp(app, frontendUrl);

    stage = 'protobuf asset validation (restore src/proto or rebuild dist)';
    const protoPath = resolveProtoPath();
    registerTransports(app, appConfig, configService, protoPath);

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
