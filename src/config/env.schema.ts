import { z } from 'zod';
import { isIP } from 'node:net';

const integer = (min: number, max: number) =>
  z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(min).max(max));
const nonBlank = z.string().refine((value) => value.trim().length > 0);
const connectionUrl = (protocols: string[]) =>
  z.string().refine((value) => {
    try {
      const url = new URL(value);
      return (
        protocols.includes(url.protocol) &&
        Boolean(
          url.hostname ||
          (protocols.includes('postgresql:') && url.searchParams.get('host')),
        )
      );
    } catch {
      return false;
    }
  });
const origin = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  })
  .transform((value) => new URL(value).origin);
const grpcBinding = z.string().refine((value) => {
  const match = /^(\[[0-9a-f:.]+\]|[^\s:/?#@]+):(\d+)$/i.exec(value);
  if (!match) return false;
  const [, host, port] = match;
  return (
    (!host.startsWith('[') || isIP(host.slice(1, -1)) === 6) &&
    Number(port) >= 1 &&
    Number(port) <= 65535
  );
});

// Unknown keys belong to Node, Prisma CLI or test runners; never return/log them.
export const replayEnvSchema = z.object({
  DATABASE_URL: connectionUrl(['postgres:', 'postgresql:']),
  RMQ_URL: connectionUrl(['amqp:', 'amqps:']).default('amqp://localhost:5672'),
  RMQ_QUEUE: nonBlank.default('loyalty_ticket_purchased'),
});
export const runtimeEnvSchema = replayEnvSchema
  .extend({
    PORT: integer(1, 65535).default(3000),
    GRPC_URL: grpcBinding.default('0.0.0.0:50051'),
    FRONTEND_URL: origin.default('http://localhost:3000'),
    INTERNAL_API_KEY: nonBlank,
    REDIS_HOST: nonBlank.refine((value) => !/[\s/]/.test(value)),
    REDIS_PORT: integer(1, 65535),
    // Explicitly empty supports existing passwordless local Redis installations.
    REDIS_PASSWORD: z.string(),
    RMQ_LOYALTY_EVENTS_QUEUE: nonBlank.default('loyalty.events'),
    OUTBOX_PUBLISH_TIMEOUT_MS: integer(1, 2147483647).default(10000),
    OUTBOX_LEASE_MS: integer(1, 2147483647).optional(),
    OUTBOX_PUBLISH_CONCURRENCY: integer(1, 50).default(5),
    RMQ_MAX_ATTEMPTS: integer(1, 10).default(3),
    RMQ_PREFETCH: integer(1, 50).default(5),
    RMQ_RETRY_BASE_MS: integer(50, 60000).default(1000),
    RMQ_RETRY_MAX_MS: integer(50, 300000).default(30000),
    RMQ_DELIVERY_LEASE_MS: integer(10000, 300000).default(30000),
  })
  .transform((env) => ({
    ...env,
    OUTBOX_LEASE_MS:
      env.OUTBOX_LEASE_MS ??
      Math.max(30000, env.OUTBOX_PUBLISH_TIMEOUT_MS + 5000),
  }))
  .superRefine((env, context) => {
    if (
      env.OUTBOX_LEASE_MS <= env.OUTBOX_PUBLISH_TIMEOUT_MS ||
      env.OUTBOX_LEASE_MS > 2147483647
    )
      context.addIssue({
        code: 'custom',
        path: ['OUTBOX_LEASE_MS'],
        message:
          'must exceed OUTBOX_PUBLISH_TIMEOUT_MS and be at most 2147483647',
      });
    if (env.RMQ_RETRY_MAX_MS < env.RMQ_RETRY_BASE_MS)
      context.addIssue({
        code: 'custom',
        path: ['RMQ_RETRY_MAX_MS'],
        message: 'must be at least RMQ_RETRY_BASE_MS',
      });
  });
export type RuntimeEnv = z.output<typeof runtimeEnvSchema>;

export function parseEnvironment<S extends z.ZodType>(
  schema: S,
  input: unknown,
): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Zod messages/inputs can contain secrets. Only report controlled key names.
    const keys = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(
      `Invalid runtime configuration: ${keys.join(', ')}. Check configuration requirements in README.`,
    );
  }
  return result.data;
}
