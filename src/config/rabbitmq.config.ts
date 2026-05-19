import { ConfigService } from '@nestjs/config';
import { ClientProviderOptions, Transport } from '@nestjs/microservices';

export function getRabbitMqConfig(
  configService: ConfigService,
): ClientProviderOptions {
  return {
    name: 'LOYALTY_PUBLISHER', // Це ім'я токена, по якому ти будеш інжектити клієнта
    transport: Transport.RMQ,
    options: {
      urls: [configService.getOrThrow<string>('RABBITMQ_URL')],
      queue: 'loyalty.events',
      queueOptions: { durable: true },
    },
  };
}
