import { ConfigService } from '@nestjs/config';
import { ClientProviderOptions, Transport } from '@nestjs/microservices';
import { INJECTION_TOKENS, LOYALTY_QUEUE_NAME } from 'src/loyalty/constants/loyalty.constants';

export function getRabbitMqConfig(
  configService: ConfigService,
): ClientProviderOptions {
  return {
    name: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT,
    transport: Transport.RMQ,
    options: {
      urls: [configService.getOrThrow<string>('RMQ_URL')],
      queue: LOYALTY_QUEUE_NAME,
      queueOptions: { durable: true },
    },
  };
}
