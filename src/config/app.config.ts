import { registerAs } from '@nestjs/config';
import { AppConfig } from 'src/interfaces/app-config.inteface';

export default registerAs('app', (): AppConfig => {
  const outboxPublishTimeoutMs = Number(
    process.env.OUTBOX_PUBLISH_TIMEOUT_MS ?? '10000',
  );
  if (
    !Number.isSafeInteger(outboxPublishTimeoutMs) ||
    outboxPublishTimeoutMs <= 0
  ) {
    throw new Error('OUTBOX_PUBLISH_TIMEOUT_MS must be a positive integer');
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    grpcUrl: process.env.GRPC_URL || '0.0.0.0:50051',
    rmqUrl: process.env.RMQ_URL || 'amqp://localhost:5672',
    rmqQueue: process.env.RMQ_QUEUE || 'loyalty_ticket_purchased',
    outboxPublishTimeoutMs,
  };
});
