import type { RuntimeEnv } from './env.schema';

export default function rmqDeliveryConfig(env: RuntimeEnv) {
  return {
    maxAttempts: env.RMQ_MAX_ATTEMPTS,
    prefetch: env.RMQ_PREFETCH,
    retryBaseMs: env.RMQ_RETRY_BASE_MS,
    retryMaxMs: env.RMQ_RETRY_MAX_MS,
    leaseMs: env.RMQ_DELIVERY_LEASE_MS,
  };
}
export type RmqDeliveryConfig = ReturnType<typeof rmqDeliveryConfig>;
