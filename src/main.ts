import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppConfig } from './interfaces/app-config.inteface';
import { getCorsConfig } from './config/cors.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const appConfig = configService.get<AppConfig>('app')!;

  const logger = new Logger('Bootstrap');

  const frontendUrl = configService.get<string>('FRONTEND_URL');
  app.enableCors(getCorsConfig(frontendUrl!));
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'loyalty.v1',
      protoPath: join(__dirname, 'proto/loyalty/v1/loyalty.proto'),
      url: appConfig.grpcUrl,
    },
  });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [appConfig.rmqUrl],
      queue: appConfig.rmqQueue,
      queueOptions: {
        durable: true,
      },
      noAck: false,
    },
  });

  await app.startAllMicroservices();
  app.enableCors();
  await app.listen(appConfig.port);

  logger.log(`HTTP Server is running on port: ${appConfig.port}`);
  logger.log(`gRPC Microservice is listening on: ${appConfig.grpcUrl}`);
  logger.log(`RMQ Microservice is connected to queue: ${appConfig.rmqQueue}`);
}

bootstrap();
