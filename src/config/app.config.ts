import { registerAs } from '@nestjs/config';
import { AppConfig } from 'src/interfaces/app-config.inteface';

export default registerAs('app', (): AppConfig => {
  const outboxPublishTimeoutMs = Number(
    process.env.OUTBOX_PUBLISH_TIMEOUT_MS ?? '10000',
  );
  if (
    !Number.isSafeInteger(outboxPublishTimeoutMs) ||
    outboxPublishTimeoutMs <= 0 ||
    outboxPublishTimeoutMs > 2147483647
  ) {
    throw new Error(
      'OUTBOX_PUBLISH_TIMEOUT_MS must be an integer from 1 to 2147483647',
    );
  }
  const outboxLeaseMs = Number(
    process.env.OUTBOX_LEASE_MS ??
      Math.max(30000, outboxPublishTimeoutMs + 5000),
  );
  if (
    !Number.isSafeInteger(outboxLeaseMs) ||
    outboxLeaseMs <= outboxPublishTimeoutMs ||
    outboxLeaseMs > 2147483647
  ) {
    throw new Error(
      'OUTBOX_LEASE_MS must be an integer greater than OUTBOX_PUBLISH_TIMEOUT_MS and at most 2147483647',
    );
  }
  const outboxPublishConcurrency = Number(
    process.env.OUTBOX_PUBLISH_CONCURRENCY ?? '5',
  );
  if (
    !Number.isSafeInteger(outboxPublishConcurrency) ||
    outboxPublishConcurrency < 1 ||
    outboxPublishConcurrency > 50
  ) {
    throw new Error(
      'OUTBOX_PUBLISH_CONCURRENCY must be an integer from 1 to 50',
    );
  }

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    grpcUrl: process.env.GRPC_URL || '0.0.0.0:50051',
    rmqUrl: process.env.RMQ_URL || 'amqp://localhost:5672',
    rmqQueue: process.env.RMQ_QUEUE || 'loyalty_ticket_purchased',
    outboxPublishTimeoutMs,
    outboxLeaseMs,
    outboxPublishConcurrency,
  };
});
