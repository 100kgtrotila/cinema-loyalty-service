import { registerAs } from '@nestjs/config';

export interface RmqDeliveryConfig {
  maxAttempts: number;
  prefetch: number;
  retryBaseMs: number;
  retryMaxMs: number;
  leaseMs: number;
}

function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export default registerAs('rmqDelivery', (): RmqDeliveryConfig => {
  const retryBaseMs = integer('RMQ_RETRY_BASE_MS', 1000, 50, 60000);
  const retryMaxMs = integer('RMQ_RETRY_MAX_MS', 30000, retryBaseMs, 300000);
  return {
    maxAttempts: integer('RMQ_MAX_ATTEMPTS', 3, 1, 10),
    prefetch: integer('RMQ_PREFETCH', 5, 1, 50),
    retryBaseMs,
    retryMaxMs,
    leaseMs: integer('RMQ_DELIVERY_LEASE_MS', 30000, 10000, 300000),
  };
});
