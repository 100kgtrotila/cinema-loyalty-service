import { ConfigService } from '@nestjs/config';
import { connect, ChannelModel, ConfirmChannel, Options } from 'amqplib';
import { fork, ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deserialize } from 'node:v8';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { PrismaService } from 'src/prisma/prisma.service';
import { inboundDeliveryId } from 'src/loyalty/consumers/rmq-delivery.service';
import { publishConfirmed } from 'src/loyalty/consumers/confirmed-rmq-publish';

const MessageSchema = z.object({ kind: z.string(), at: z.number() });
interface Worker {
  child: ChildProcess;
  messages: z.infer<typeof MessageSchema>[];
  output: string;
}

describe('Inbound reliability on real PostgreSQL and RabbitMQ', () => {
  let prisma: PrismaService;
  let connection: ChannelModel;
  let channel: ConfirmChannel;
  let queue: string;
  let userId: string;
  let queueCreated = false;
  const workers: Worker[] = [];
  const fixtureEnv: NodeJS.ProcessEnv = {};
  let brokerHttp: URL;
  const brokerHeaders = {
    Authorization: `Basic ${Buffer.from('loyalty_test:loyalty_test').toString('base64')}`,
  };

  async function until<T>(
    read: () => Promise<T> | T,
    accept: (value: T) => boolean,
    description: string,
    timeout = 10000,
  ): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (accept(value)) return value;
      const failed = workers.find((w) =>
        w.messages.some((m) => m.kind === 'worker-failed'),
      );
      if (failed) throw new Error(`Fixture worker failed: ${failed.output}`);
      await delay(10);
    }
    throw new Error(
      `Fixture timed out: ${description}; ${workers.map((w) => w.output).join('\n')}`,
    );
  }

  async function startWorker(
    options: { fault?: string; loseAck?: boolean; backoff?: number } = {},
  ): Promise<Worker> {
    const child = fork(resolve('test/fixtures/rmq-delivery-worker.cjs'), [], {
      env: {
        ...fixtureEnv,
        RMQ_TEST_QUEUE: queue,
        RMQ_TEST_FAULT: options.fault ?? '',
        RMQ_TEST_LOSE_ACK: String(options.loseAck ?? false),
        RMQ_TEST_BACKOFF: String(options.backoff ?? 50),
      },
      execArgv: ['--max-old-space-size=128'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const worker: Worker = { child, messages: [], output: '' };
    workers.push(worker);
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (data: unknown) => {
        if (Buffer.isBuffer(data)) worker.output += data.toString();
        if (worker.output.length > 65536) {
          child.kill('SIGKILL');
          throw new Error('Fixture log limit exceeded');
        }
      });
    child.on('message', (data: unknown) => {
      const result = MessageSchema.safeParse(data);
      if (result.success) worker.messages.push(result.data);
    });
    await until(
      () => worker.messages,
      (messages) => messages.some((m) => m.kind === 'ready'),
      'worker ready',
    );
    return worker;
  }

  async function stop(worker: Worker, crash = false) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null)
      return;
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => worker.child.kill('SIGKILL'), 5000);
      worker.child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
      if (crash) worker.child.kill('SIGKILL');
      else if (worker.child.connected) worker.child.send('stop');
    });
  }

  beforeAll(async () => {
    const database = new URL(process.env.RMQ_TEST_DATABASE_URL ?? '');
    const rabbit = new URL(process.env.RMQ_TEST_RABBIT_URL ?? '');
    const http = new URL(process.env.RMQ_TEST_RABBIT_HTTP ?? '');
    brokerHttp = http;
    if (
      [database, rabbit, http].some((url) => url.hostname !== '127.0.0.1') ||
      database.pathname !== '/loyalty_rmq' ||
      database.username !== 'loyalty_test'
    )
      throw new Error(
        'Run through bun run test:rmq with disposable dependencies',
      );
    for (const key of [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'NODE_OPTIONS',
    ])
      if (process.env[key]) fixtureEnv[key] = process.env[key];
    fixtureEnv.RMQ_TEST_DATABASE_URL = database.toString();
    fixtureEnv.RMQ_TEST_RABBIT_URL = rabbit.toString();
    fixtureEnv.NODE_ENV = 'test';
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: database.toString() }),
    );
    await prisma.$connect();
    connection = await connect(rabbit.toString());
    connection.on('error', () => {});
    channel = await connection.createConfirmChannel();
    channel.on('error', () => {});
    const headers = {
      Authorization: `Basic ${Buffer.from('loyalty_test:loyalty_test').toString('base64')}`,
    };
    const overviewResponse = await fetch(new URL('/api/overview', http), {
      headers,
    });
    expect(overviewResponse.status).toBe(200);
    const overview = z
      .object({ rabbitmq_version: z.string() })
      .parse(await overviewResponse.json());
    const policyResponse = await fetch(new URL('/api/policies/%2F', http), {
      headers,
    });
    expect(policyResponse.status).toBe(200);
    const policies: unknown = await policyResponse.json();
    writeFileSync(
      '.tmp/rmq-broker-evidence.json',
      JSON.stringify(
        {
          version: overview.rabbitmq_version,
          policies,
          expectedFixtureQueueType: 'classic',
          configuredPrefetch: 1,
        },
        null,
        2,
      ),
    );
  });

  beforeEach(async () => {
    queueCreated = false;
    await prisma.$executeRaw`TRUNCATE inbound_deliveries, loyalty_profiles, points_transactions, processed_events, outbox_events, achievement_dispatch_intents, user_bonus_grants CASCADE`;
    queue = `rmq-test-${randomUUID()}`;
    await channel.assertQueue(queue, { durable: true });
    queueCreated = true;
    userId = randomUUID();
    await prisma.loyaltyProfile.create({ data: { userId } });
  });

  afterEach(async () => {
    for (const worker of workers) await stop(worker);
    const logs = workers.map((worker) => worker.output);
    workers.length = 0;
    if (queueCreated) await channel.deleteQueue(queue);
    for (const output of logs) {
      for (const privateValue of [
        'private@example.invalid',
        'PRIVATE_NAME',
        '1990-05-17',
        'private-download',
        'PRIVATE_EXTRA',
      ])
        expect(output).not.toContain(privateValue);
    }
  });

  afterAll(async () => {
    try {
      await channel?.close();
    } finally {
      try {
        await connection?.close();
      } finally {
        await prisma?.$disconnect();
      }
    }
  });

  function purchase(amount = 25) {
    return {
      eventId: randomUUID(),
      userId,
      orderId: randomUUID(),
      totalAmount: amount,
      ticketAmount: amount,
      foodAmount: 0,
      paidAmount: amount,
      pointsUsed: 0,
      eventType: 'STANDARD',
      purchasedAt: new Date().toISOString(),
      userEmail: 'private@example.invalid',
      userName: 'PRIVATE_NAME',
      downloadUrl: 'https://example.invalid/private-download',
      extra: 'PRIVATE_EXTRA',
      metadataDOB: '1990-05-17',
    };
  }

  async function send(
    data: unknown,
    pattern = 'TicketPurchased',
    properties: Options.Publish = {},
  ) {
    const body = Buffer.from(JSON.stringify({ pattern, data }));
    await publishConfirmed(
      channel,
      queue,
      body,
      { contentType: 'application/json', ...properties },
      5000,
    );
    return { body, id: inboundDeliveryId(queue, body) };
  }

  const row = (id: string) =>
    prisma.inboundDelivery.findUnique({ where: { id } });
  const quarantined = (id: string) =>
    until(
      () => row(id),
      (value) => value?.quarantinedAt != null,
      'durable quarantine',
    );
  const completed = (id: string) =>
    until(
      () => row(id),
      (value) => value?.completedAt != null,
      'committed outcome',
    );

  async function noBusinessEffect(eventId: string) {
    expect(
      await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
    ).toMatchObject({
      balance: 0,
      lifetimePoints: 0,
      yearPoints: 0,
      yearVisits: 0,
    });
    expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(0);
    expect(await prisma.processedEvent.count({ where: { eventId } })).toBe(0);
    expect(
      await prisma.outboxEvent.count({ where: { aggregateId: userId } }),
    ).toBe(0);
    expect(
      await prisma.achievementDispatchIntent.count({ where: { userId } }),
    ).toBe(0);
  }

  it('quarantines integer overflow with original envelope/properties and lets another user progress', async () => {
    const worker = await startWorker();
    const consumers = await until(
      async () => {
        const response = await fetch(
          new URL('/api/consumers/%2F', brokerHttp),
          { headers: brokerHeaders },
        );
        return z
          .array(
            z.object({
              queue: z.object({ name: z.string() }),
              prefetch_count: z.number(),
              ack_required: z.boolean(),
            }),
          )
          .parse(await response.json());
      },
      (value) => value.some((consumer) => consumer.queue.name === queue),
      'broker registered consumer',
    );
    expect(
      consumers.find((consumer) => consumer.queue.name === queue),
    ).toMatchObject({ prefetch_count: 1, ack_required: true });
    const queueResponse = await fetch(
      new URL(`/api/queues/%2F/${queue}`, brokerHttp),
      { headers: brokerHeaders },
    );
    const queueInfo: unknown = await queueResponse.json();
    expect(queueInfo).toMatchObject({
      type: 'classic',
      durable: true,
      arguments: {},
      effective_policy_definition: {},
    });
    writeFileSync(
      '.tmp/rmq-effective-queue.json',
      JSON.stringify({ queue: queueInfo, consumers }, null, 2),
    );
    const data = purchase(2147483648);
    const message = await send(data, 'TicketPurchased', {
      messageId: data.eventId,
      correlationId: 'fixture-correlation',
      headers: { custom: 'preserved' },
    });
    const stored = await quarantined(message.id);
    expect(stored).toMatchObject({
      attempts: 1,
      errorCode: 'ACCOUNTING_RANGE_EXCEEDED',
      leaseToken: null,
    });
    if (!stored?.originalBody || !stored.originalProperties)
      throw new Error('Quarantine bytes missing');
    expect(Buffer.from(stored.originalBody)).toEqual(message.body);
    const properties: unknown = deserialize(
      Buffer.from(stored.originalProperties),
    );
    expect(properties).toMatchObject({
      messageId: data.eventId,
      correlationId: 'fixture-correlation',
      headers: { custom: 'preserved' },
    });
    await noBusinessEffect(data.eventId);
    const another = randomUUID();
    const good = await send({ ...purchase(), userId: another });
    await completed(good.id);
    expect(
      await prisma.loyaltyProfile.findUniqueOrThrow({
        where: { userId: another },
      }),
    ).toMatchObject({ balance: 25 });
    expect(
      worker.messages.filter((m) => m.kind === 'redelivered'),
    ).toHaveLength(0);
    await until(
      () => channel.checkQueue(queue),
      (state) => state.messageCount === 0,
      'source drained',
    );
  });

  it('recovers a transient processing failure with persisted backoff and one business effect', async () => {
    const worker = await startWorker({ fault: 'transient-once', backoff: 100 });
    const data = purchase();
    const message = await send(data);
    expect(await completed(message.id)).toMatchObject({
      attempts: 2,
      quarantinedAt: null,
    });
    const attempts = worker.messages.filter((m) => m.kind === 'work-started');
    expect(attempts).toHaveLength(2);
    expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(90);
    expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(1);
    expect(
      await prisma.processedEvent.count({ where: { eventId: data.eventId } }),
    ).toBe(1);
  });

  it('exhausts unknown errors without unbounded requeue or sensitive exception logging', async () => {
    const worker = await startWorker({ fault: 'unknown' });
    const data = purchase();
    const message = await send(data);
    expect(await quarantined(message.id)).toMatchObject({
      attempts: 3,
      errorCode: 'UNEXPECTED_PROCESSING_FAILURE',
    });
    expect(
      worker.messages.filter((m) => m.kind === 'work-started'),
    ).toHaveLength(3);
    expect(worker.messages.filter((m) => m.kind === 'delivered')).toHaveLength(
      1,
    );
    expect(
      worker.messages.filter((m) => m.kind === 'redelivered'),
    ).toHaveLength(0);
    await noBusinessEffect(data.eventId);
  });

  it('does not reset the automatic attempt budget after a real process restart', async () => {
    const first = await startWorker({ fault: 'unknown', backoff: 1000 });
    const data = purchase();
    const message = await send(data);
    await until(
      () => row(message.id),
      (value) =>
        value?.attempts === 1 &&
        value.errorCode != null &&
        value.leaseToken === null,
      'first failure persisted',
    );
    await stop(first, true);
    const second = await startWorker({ fault: 'unknown' });
    expect(await quarantined(message.id)).toMatchObject({
      attempts: 3,
      maxAttempts: 3,
    });
    expect(
      second.messages.filter((m) => m.kind === 'work-started'),
    ).toHaveLength(2);
    await noBusinessEffect(data.eventId);
  });

  it('counts a crash on the final admitted attempt and quarantines after restart', async () => {
    const data = purchase();
    const body = Buffer.from(
      JSON.stringify({ pattern: 'TicketPurchased', data }),
    );
    const id = inboundDeliveryId(queue, body);
    await prisma.inboundDelivery.create({
      data: {
        id,
        operation: 'TicketPurchased',
        sourceQueue: queue,
        attempts: 2,
      },
    });
    const first = await startWorker({ fault: 'block' });
    await send(data);
    await until(
      () => first.messages,
      (value) => value.some((m) => m.kind === 'work-started'),
      'final attempt entered',
    );
    expect(await row(id)).toMatchObject({ attempts: 3 });
    await stop(first, true);
    await prisma.$executeRaw`UPDATE inbound_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${id}`;
    const second = await startWorker();
    expect(await quarantined(id)).toMatchObject({
      attempts: 3,
      errorCode: 'DELIVERY_ATTEMPTS_EXHAUSTED',
    });
    expect(
      second.messages.filter((m) => m.kind === 'work-started'),
    ).toHaveLength(0);
    await noBusinessEffect(data.eventId);
  });

  it('holds unacked work under prefetch backpressure when quarantine storage is unavailable', async () => {
    await prisma.$executeRaw`CREATE FUNCTION reject_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture quarantine unavailable'; END $$`;
    await prisma.$executeRaw`CREATE TRIGGER reject_quarantine BEFORE UPDATE OF quarantined_at ON inbound_deliveries FOR EACH ROW WHEN (NEW.quarantined_at IS NOT NULL) EXECUTE FUNCTION reject_quarantine()`;
    try {
      const worker = await startWorker();
      const data = purchase(2147483648);
      const poison = await send(data);
      await until(
        () => row(poison.id),
        (value) =>
          value?.quarantineRequired === true && value.quarantinedAt === null,
        'quarantine write blocked',
      );
      const good = await send({ ...purchase(), userId: randomUUID() });
      await until(
        () => channel.checkQueue(queue),
        (state) => state.messageCount === 1,
        'prefetch retains next message',
      );
      expect(
        worker.messages.filter((m) => m.kind === 'delivered'),
      ).toHaveLength(1);
      expect(
        worker.messages.filter((m) => m.kind === 'redelivered'),
      ).toHaveLength(0);
      expect(await row(poison.id)).toMatchObject({
        attempts: 1,
        quarantinedAt: null,
      });
      await noBusinessEffect(data.eventId);
      await prisma.$executeRaw`DROP TRIGGER reject_quarantine ON inbound_deliveries`;
      await quarantined(poison.id);
      await completed(good.id);
      expect(await row(poison.id)).toMatchObject({ attempts: 1 });
    } finally {
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS reject_quarantine ON inbound_deliveries`;
      await prisma.$executeRaw`DROP FUNCTION reject_quarantine()`;
    }
  });

  it('deduplicates real broker redelivery after the committed worker loses its ACK', async () => {
    const first = await startWorker({ loseAck: true });
    const data = purchase();
    const message = await send(data);
    await until(
      () => first.child.exitCode,
      (value) => value === 0,
      'worker exited before basic.ack',
    );
    expect(await row(message.id)).toMatchObject({
      attempts: 1,
      completedAt: expect.any(Date),
    });
    const second = await startWorker();
    await until(
      () => second.messages,
      (value) => value.some((m) => m.kind === 'redelivered'),
      'unacked original redelivered',
    );
    expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(1);
    expect(
      second.messages.filter((m) => m.kind === 'work-started'),
    ).toHaveLength(0);
    expect(await row(message.id)).toMatchObject({ attempts: 1 });
  });

  it('serializes duplicate deliveries across two real worker processes', async () => {
    const one = await startWorker();
    const two = await startWorker();
    const data = purchase();
    const message = await send(data);
    await send(data);
    await completed(message.id);
    await until(
      () =>
        [...one.messages, ...two.messages].filter((m) => m.kind === 'delivered')
          .length,
      (value) => value === 2,
      'both copies delivered',
    );
    expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(1);
    expect(await row(message.id)).toMatchObject({ attempts: 1 });
  });

  it.each(['block', 'block-unknown'])(
    'fences a late %s owner after a successor commits',
    async (fault) => {
      const old = await startWorker({ fault });
      const data = purchase();
      const message = await send(data);
      const initial = await until(
        () => row(message.id),
        (value) => value?.leaseToken != null,
        'first owner',
      );
      await until(
        () => old.messages,
        (messages) => messages.some((value) => value.kind === 'work-started'),
        'old work blocked',
      );
      await prisma.$executeRaw`UPDATE inbound_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${message.id}`;
      await startWorker();
      await send(data);
      const successor = await completed(message.id);
      expect(successor).toMatchObject({
        attempts: 2,
        quarantineRequired: false,
        errorCode: null,
      });
      expect(initial?.leaseToken).not.toBeNull();
      old.child.send('release');
      await until(
        () => channel.checkQueue(queue),
        (value) => value.messageCount === 0,
        'both copies consumed',
      );
      // Stop waits for the old callback to finish; its result cannot overwrite the successor.
      await until(
        () => old.messages,
        (messages) => messages.some((value) => value.kind === 'handled'),
        'late result returned',
      );
      expect(await row(message.id)).toMatchObject({
        attempts: 2,
        completedAt: successor?.completedAt,
        quarantineRequired: false,
        errorCode: null,
      });
      expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(
        1,
      );
    },
  );

  async function replayCli(id: string, replayId: string) {
    return new Promise<{ code: number | null; output: string }>(
      (resolveExit) => {
        const child = spawn(
          process.execPath,
          [
            resolve('dist/tools/replay-quarantine.js'),
            '--delivery-id',
            id,
            '--replay-id',
            replayId,
            '--consumers-stopped',
          ],
          {
            env: {
              ...fixtureEnv,
              DATABASE_URL: fixtureEnv.RMQ_TEST_DATABASE_URL,
              RMQ_URL: fixtureEnv.RMQ_TEST_RABBIT_URL,
              RMQ_QUEUE: queue,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
        child.stderr.on('data', (data: Buffer) => {
          output += data.toString();
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          resolveExit({ code, output });
        });
      },
    );
  }

  it('replays with the original envelope and stable replay ID without a second budget reset or reward', async () => {
    const first = await startWorker({ fault: 'permanent' });
    const data = purchase();
    const message = await send(data, 'TicketPurchased', {
      messageId: data.eventId,
      correlationId: 'original-correlation',
      headers: { custom: 'preserved' },
    });
    await quarantined(message.id);
    expect((await replayCli(message.id, randomUUID())).code).toBe(1); // Active consumers cannot be bypassed by a flag.
    await stop(first);
    const replayId = randomUUID();
    expect((await replayCli(message.id, replayId)).code).toBe(0);
    expect((await replayCli(message.id, replayId)).code).toBe(0);
    expect(await row(message.id)).toMatchObject({
      replayCount: 1,
      attempts: 0,
      replayId,
    });
    const copy = await channel.get(queue, { noAck: false });
    if (!copy) throw new Error('Confirmed replay copy is missing');
    expect(copy.content).toEqual(message.body);
    expect(copy.properties).toMatchObject({
      messageId: data.eventId,
      correlationId: 'original-correlation',
      headers: { custom: 'preserved' },
    });
    channel.nack(copy, false, true);
    await startWorker();
    await completed(message.id);
    expect(await prisma.pointsTransaction.count({ where: { userId } })).toBe(1);
    expect(
      await prisma.processedEvent.count({ where: { eventId: data.eventId } }),
    ).toBe(1);
    expect(await row(message.id)).toMatchObject({
      replayCount: 1,
      attempts: 1,
    });
  });

  it('rejects a mandatory unroutable publication even when RabbitMQ confirms it', async () => {
    await expect(
      publishConfirmed(
        channel,
        `missing-${randomUUID()}`,
        Buffer.from('fixture'),
        {},
        2000,
      ),
    ).rejects.toThrow('REPLAY_UNROUTABLE');
    await channel.waitForConfirms();
  });

  it.each(['TicketPurchased', 'UserDateOfBirthSet'])(
    'quarantines invalid %s payload without raw validation values in logs',
    async (pattern) => {
      await startWorker();
      const data = {
        ...purchase(),
        userId: 'invalid-private@example.invalid',
        dateOfBirth: '1990-05-17',
      };
      const message = await send(data, pattern);
      expect(await quarantined(message.id)).toMatchObject({
        attempts: 1,
        errorCode:
          pattern === 'TicketPurchased'
            ? 'INVALID_PURCHASE_PAYLOAD'
            : 'INVALID_DOB_PAYLOAD',
      });
    },
  );

  it('processes a compatible DOB alias without exposing DOB or extra metadata in logs', async () => {
    await startWorker();
    const data = {
      userId,
      dob: '1990-05-17',
      userEmail: 'private@example.invalid',
      userName: 'PRIVATE_NAME',
      extra: 'PRIVATE_EXTRA',
    };
    const message = await send(data, 'UserDateOfBirthSet');
    await completed(message.id);
    expect(
      (
        await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } })
      ).birthdayDate?.toISOString(),
    ).toBe('1990-05-17T00:00:00.000Z');
  });

  it('quarantines a domain-invalid DOB without raw dates in service diagnostics', async () => {
    await startWorker();
    const message = await send(
      {
        userId,
        dateOfBirth: '1990-02-31',
        userEmail: 'private@example.invalid',
      },
      'UserDateOfBirthSet',
    );
    expect(await quarantined(message.id)).toMatchObject({
      attempts: 1,
      errorCode: 'INVALID_DATE_OF_BIRTH',
    });
    expect(
      (await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }))
        .birthdayDate,
    ).toBeNull();
  });

  it('redacts sensitive DOB processing exceptions while exhausting a bounded budget', async () => {
    await startWorker({ fault: 'unknown' });
    const message = await send(
      {
        userId,
        dateOfBirth: '1990-05-17',
        userEmail: 'private@example.invalid',
      },
      'UserDateOfBirthSet',
    );
    expect(await quarantined(message.id)).toMatchObject({
      attempts: 3,
      errorCode: 'UNEXPECTED_PROCESSING_FAILURE',
    });
  });

  it('preserves DOB setter semantics A to B to A without an event identifier', async () => {
    const worker = await startWorker();
    for (const [index, dateOfBirth] of [
      '1990-05-17',
      '1991-06-18',
      '1990-05-17',
    ].entries()) {
      await send({ userId, dateOfBirth }, 'UserDateOfBirthSet');
      await until(
        () =>
          worker.messages.filter((value) => value.kind === 'handled').length,
        (value) => value === index + 1,
        'DOB delivery acknowledged',
      );
      expect(
        (
          await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } })
        ).birthdayDate?.toISOString(),
      ).toBe(`${dateOfBirth}T00:00:00.000Z`);
    }
  });
});
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
