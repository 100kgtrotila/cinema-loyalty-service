// Run the actual service in a separate Node process, including source Prisma
// imports. Killing this process leaves a committed claim without completion.
require('ts-node').register({
  transpileOnly: true,
  experimentalResolver: true,
});
require('tsconfig-paths/register');
const { ConfigService } = require('@nestjs/config');
const { EventEmitter2 } = require('eventemitter2');
const { PrismaService } = require('../../src/prisma/prisma.service');
const {
  OutboxPublisherService,
} = require('../../src/loyalty/outbox-publisher.service');

async function main() {
  const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
  const url = new URL(databaseUrl);
  if (
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/loyalty_integration' ||
    url.username !== 'loyalty_test'
  ) {
    throw new Error('Disposable integration database required');
  }
  const config = new ConfigService({
    DATABASE_URL: databaseUrl,
    app: {
      outboxPublishTimeoutMs: 60000,
      outboxLeaseMs: 120000,
      outboxPublishConcurrency: 2,
    },
  });
  const prisma = new PrismaService(config);
  const emitter = new EventEmitter2();
  emitter.on('loyalty.tier_upgraded', async () => {
    process.send?.({ type: 'publishing' });
    if (process.env.OUTBOX_WORKER_MODE === 'hold') await new Promise(() => {});
  });
  try {
    await prisma.$connect();
    const publisher = new OutboxPublisherService(prisma, emitter, config);
    await publisher.publishPendingEvents();
    process.send?.({ type: 'done' });
  } finally {
    await prisma.$disconnect();
    process.disconnect?.();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  process.disconnect?.();
});
