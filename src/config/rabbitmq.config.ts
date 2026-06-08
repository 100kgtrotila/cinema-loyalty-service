import { ConfigService } from '@nestjs/config';
import { ClientProvider, Transport } from '@nestjs/microservices';
import { LOYALTY_EVENTS_QUEUE_NAME } from 'src/loyalty/constants/loyalty.constants';

export function getRabbitMqConfig(
  configService: ConfigService,
): ClientProvider {
  return {
    transport: Transport.RMQ,
    options: {
      urls: [
        configService.get<string>('RMQ_URL') ??
          configService.get<string>('app.rmqUrl') ??
          'amqp://localhost:5672',
      ],
      queue:
        configService.get<string>('RMQ_LOYALTY_EVENTS_QUEUE') ??
        LOYALTY_EVENTS_QUEUE_NAME,
      queueOptions: { durable: true },
    },
  };
}
