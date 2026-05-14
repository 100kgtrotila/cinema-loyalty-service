import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        package: 'loyalty.v1',
        protoPath: join(__dirname, '/proto/loyalty/v1/loyalty.proto'),
        url: '0.0.0.0:50051',
      },
    },
  );

  await app.listen();
  console.log('Loyalty gRPC Microservice is listening on port 50051');
}
bootstrap();
