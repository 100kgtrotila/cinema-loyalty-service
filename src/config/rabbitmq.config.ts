import type { RuntimeConfiguration } from './app.config';
import { ConfigService } from '@nestjs/config';
import { ClientProvider, Transport } from '@nestjs/microservices';

export function getRabbitMqConfig(
  configService: ConfigService<RuntimeConfiguration>,
): ClientProvider {
  const url = configService.getOrThrow('app.rmqUrl', { infer: true });
  const queue = configService.getOrThrow('RMQ_LOYALTY_EVENTS_QUEUE', {
    infer: true,
  });
  return {
    transport: Transport.RMQ,
    options: {
      urls: [url],
      queue,
      queueOptions: { durable: true },
    },
  };
}
