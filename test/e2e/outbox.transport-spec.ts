import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { connect, ChannelModel, Channel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { OutboxPublisherService } from 'src/loyalty/outbox-publisher.service';
import { TierUpgradeListener } from 'src/loyalty/notifications/tier-upgrade.listener';
import {
  INJECTION_TOKENS,
  RABBITMQ_EVENTS,
} from 'src/loyalty/constants/loyalty.constants';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Run bun run test:transports (${name} missing)`);
  return value;
}

describe('Outbox → real RabbitMQ confirm publication', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let publisher: OutboxPublisherService;
  let client: ClientProxy;
  let connection: ChannelModel;
  let channel: Channel;
  const queue = `outbox-lease-${randomUUID()}`;

  beforeAll(async () => {
    const databaseUrl = required('E2E_OUTBOX_DATABASE_URL');
    const url = new URL(databaseUrl);
    if (
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/loyalty_outbox_transport'
    )
      throw new Error('Disposable E2E database required');
    connection = await connect(required('E2E_RABBIT_URL'));
    channel = await connection.createChannel();
    await channel.assertQueue(queue, { durable: true });
    client = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [required('E2E_RABBIT_URL')],
        queue,
        queueOptions: { durable: true },
      },
    });
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        PrismaService,
        OutboxPublisherService,
        TierUpgradeListener,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            DATABASE_URL: databaseUrl,
            app: {
              outboxPublishTimeoutMs: 10000,
              outboxLeaseMs: 30000,
              outboxPublishConcurrency: 2,
            },
          }),
        },
        { provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT, useValue: client },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    publisher = module.get(OutboxPublisherService);
    await module.init();
    await client.connect();
  });
  afterAll(async () => {
    if (client) await client.close();
    if (prisma) await prisma.$disconnect();
    if (module) await module.close();
    if (channel) {
      await channel.deleteQueue(queue);
      await channel.close();
    }
    if (connection) await connection.close();
  });

  it('publishes the same body and messageId after Rabbit accepted a send but DB completion failed', async () => {
    const userId = randomUUID();
    const row = await prisma.outboxEvent.create({
      data: {
        type: RABBITMQ_EVENTS.TIER_UPGRADED,
        payload: { userId, oldTier: 'BRONZE', newTier: 'SILVER' },
        aggregateType: 'LOYALTY_PROFILE',
        aggregateId: userId,
      },
    });
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION reject_transport_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'injected transport completion failure'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_transport_completion BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION reject_transport_completion()`,
    );
    try {
      await publisher.publishPendingEvents();
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe('PROCESSING');
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER reject_transport_completion ON outbox_events',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION reject_transport_completion()',
      );
    }
    const first = await channel.get(queue, { noAck: false });
    if (!first) throw new Error('First confirmed Rabbit message missing');
    expect(first.properties.messageId).toBe(row.id);
    expect(first.properties.deliveryMode).toBe(2);
    const body: unknown = JSON.parse(first.content.toString());
    expect(body).toEqual({
      pattern: RABBITMQ_EVENTS.TIER_UPGRADED,
      data: {
        userId,
        oldTier: 'BRONZE',
        newTier: 'SILVER',
        upgradedAt: row.createdAt.toISOString(),
      },
    });
    channel.ack(first);
    await prisma.$executeRaw`UPDATE outbox_events SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${row.id}::uuid`;
    await publisher.publishPendingEvents();
    await prisma.$executeRaw`UPDATE outbox_events SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = ${row.id}::uuid`;
    await publisher.publishPendingEvents();
    const second = await channel.get(queue, { noAck: false });
    if (!second) throw new Error('Recovered Rabbit message missing');
    expect(second.content.toString()).toBe(first.content.toString());
    expect(second.properties.messageId).toBe(first.properties.messageId);
    expect(second.properties.deliveryMode).toBe(2);
    channel.ack(second);
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });
});
