import { ConfigService } from '@nestjs/config';
import { ClientProviderOptions, Transport } from '@nestjs/microservices';

export function getRabbitMqConfig(
  configService: ConfigService,
): ClientProviderOptions {
  return {
    name: 'LOYALTY_PUBLISHER',
    transport: Transport.RMQ,
    options: {
      urls: [configService.getOrThrow<string>('RMQ_URL')],
      queue: 'loyalty.events',
      queueOptions: { durable: true },
    },
  };
}
