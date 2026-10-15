import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from 'eventemitter2';
import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { PrismaService } from 'src/prisma/prisma.service';
import { OutboxPublisherService } from 'src/loyalty/outbox-publisher.service';
import { RABBITMQ_EVENTS } from 'src/loyalty/constants/loyalty.constants';

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error('Resolver not initialized');
  };
  let reject: (reason: Error) => void = () => {
    throw new Error('Rejecter not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('Rabbit outbox leases on PostgreSQL', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  const children = new Set<ChildProcess>();
  const type = RABBITMQ_EVENTS.TIER_UPGRADED;

  beforeAll(async () => {
    const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
    if (!databaseUrl) throw new Error('Run bun run test:integration');
    const url = new URL(databaseUrl);
    if (
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/loyalty_integration' ||
      url.username !== 'loyalty_test'
    ) {
      throw new Error('Disposable local PostgreSQL required');
    }
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ DATABASE_URL: databaseUrl }),
        },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.$connect();
  });
  beforeEach(async () => {
    await prisma.outboxEvent.deleteMany();
  });
  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    if (prisma) await prisma.$disconnect();
    if (module) await module.close();
  });

  function publisher(
    deliver: (...args: unknown[]) => Promise<void>,
    timeoutMs = 1000,
    concurrency = 2,
  ) {
    const emitter = new EventEmitter2();
    // emitAsync awaits returned promises; EventEmitter2's registration type is void.
    const listener = (...args: unknown[]): unknown => deliver(...args);
    emitter.on(type, listener);
    return new OutboxPublisherService(
      prisma,
      emitter,
      new ConfigService({
        app: {
          outboxPublishTimeoutMs: timeoutMs,
          outboxLeaseMs: timeoutMs + 5000,
          outboxPublishConcurrency: concurrency,
        },
      }),
    );
  }
  async function event(maxAttempts = 5) {
    return prisma.outboxEvent.create({
      data: {
        type,
        payload: { userId: randomUUID(), oldTier: 'BRONZE', newTier: 'SILVER' },
        aggregateType: 'LOYALTY_PROFILE',
        aggregateId: randomUUID(),
        maxAttempts,
      },
    });
  }
  async function expire(id: string) {
    await prisma.$executeRaw`UPDATE outbox_events SET lease_expires_at = statement_timestamp() - interval '1 second' WHERE id = ${id}::uuid`;
  }
  async function due(id: string) {
    await prisma.$executeRaw`UPDATE outbox_events SET next_attempt_at = statement_timestamp() - interval '1 second' WHERE id = ${id}::uuid`;
  }
  async function recoverAndRetry(worker: OutboxPublisherService, id: string) {
    await worker.publishPendingEvents(); // Expiry recovery schedules backoff.
    await due(id);
    await worker.publishPendingEvents();
  }
  function start(mode: 'hold' | 'deliver') {
    const child = spawn(
      process.execPath,
      [resolve('test/fixtures/outbox-publisher-worker.cjs')],
      {
        env: { ...process.env, OUTBOX_WORKER_MODE: mode },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.add(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const publishing = deferred<void>();
    const done = deferred<void>();
    // Attach rejection handlers immediately, including when a process is killed.
    void publishing.promise.catch(() => {});
    void done.promise.catch(() => {});
    child.on('message', (message: unknown) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message)
      )
        return;
      if (message.type === 'publishing') publishing.resolve();
      if (message.type === 'done') done.resolve();
    });
    child.on('error', (error) => {
      publishing.reject(error);
      done.reject(error);
    });
    child.on('exit', (code) => {
      const error = new Error(`Publisher exited ${code}: ${output}`);
      publishing.reject(error);
      done.reject(error);
    });
    return { child, publishing: publishing.promise, done: done.promise };
  }

  it('recovers a committed claim after killing and restarting a real publisher process', async () => {
    const row = await event();
    const first = start('hold');
    await first.publishing;
    expect(
      (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe('PROCESSING');
    const exited = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await exited;
    await expire(row.id);
    const restarted = start('deliver');
    await restarted.done;
    await due(row.id);
    const retry = start('deliver');
    await retry.done;
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: 'COMPLETED', attempts: 2 });
  });

  it('allows only one of two simultaneous publishers to claim an event and excludes an active lease', async () => {
    const row = await event();
    const entered = deferred<void>();
    const release = deferred<void>();
    let deliveries = 0;
    const deliver = async () => {
      deliveries++;
      entered.resolve();
      await release.promise;
    };
    const first = publisher(deliver);
    const second = publisher(deliver);
    const runs = [first.publishPendingEvents(), second.publishPendingEvents()];
    await entered.promise;
    await Promise.race(runs); // The losing publisher has also finished its claim.
    expect(deliveries).toBe(1);
    const claimed = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(claimed).toMatchObject({
      status: 'PROCESSING',
      attempts: 1,
      leaseToken: expect.any(String),
    });
    await publisher(() => {
      deliveries++;
      return Promise.resolve();
    }).publishPendingEvents();
    expect(deliveries).toBe(1);
    release.resolve();
    await Promise.all(runs);
    expect(
      (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe('COMPLETED');
  });

  it.each(['success', 'failure'])(
    'rejects late %s from an old owner after a new claim',
    async (result) => {
      const row = await event();
      const entered = deferred<void>();
      const old = deferred<void>();
      const firstRun = publisher(async () => {
        entered.resolve();
        await old.promise;
      }).publishPendingEvents();
      await entered.promise;
      const firstClaim = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: row.id },
      });
      await expire(row.id);
      const nextEntered = deferred<void>();
      const next = deferred<void>();
      const second = publisher(async () => {
        nextEntered.resolve();
        await next.promise;
      });
      await second.publishPendingEvents();
      await due(row.id);
      const secondRun = second.publishPendingEvents();
      await nextEntered.promise;
      const secondClaim = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(secondClaim.leaseToken).not.toBe(firstClaim.leaseToken);
      if (result === 'success') old.resolve();
      else old.reject(new Error('late failure'));
      await firstRun;
      expect(
        await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }),
      ).toEqual(secondClaim);
      next.resolve();
      await secondRun;
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe('COMPLETED');
    },
  );

  it.each(['error', 'timeout'])(
    'does not report COMPLETED on broker %s and enforces backoff',
    async (failure) => {
      const row = await event(2);
      let calls = 0;
      const worker = publisher(async () => {
        calls++;
        if (failure === 'error') throw new Error('broker unavailable');
        await new Promise<void>(() => {});
      }, 25);
      await worker.publishPendingEvents();
      const failed = await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(failed).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        publishedAt: null,
        leaseToken: null,
      });
      const [timing] = await prisma.$queryRaw<
        { delay: number }[]
      >`SELECT EXTRACT(EPOCH FROM (next_attempt_at - updated_at))::int AS delay FROM outbox_events WHERE id = ${row.id}::uuid`;
      expect(timing.delay).toBe(5);
      await worker.publishPendingEvents();
      expect(calls).toBe(1);
      await due(row.id);
      await worker.publishPendingEvents();
      expect(
        await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ status: 'FAILED', attempts: 2, publishedAt: null });
      await worker.publishPendingEvents();
      expect(calls).toBe(2);
    },
  );

  it('caps exponential backoff at 60 seconds while honoring the per-row attempt budget', async () => {
    const row = await event(7);
    const worker = publisher(() =>
      Promise.reject(new Error('transient broker error')),
    );
    for (const [index, delay] of [5, 10, 20, 40, 60, 60].entries()) {
      await worker.publishPendingEvents();
      const [state] = await prisma.$queryRaw<
        { delay: number; attempts: number; status: string }[]
      >`
        SELECT EXTRACT(EPOCH FROM (next_attempt_at - updated_at))::int AS delay, attempts::int, status::text
        FROM outbox_events WHERE id = ${row.id}::uuid`;
      expect(state).toEqual({ delay, attempts: index + 1, status: 'PENDING' });
      await due(row.id);
    }
    await worker.publishPendingEvents();
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: 'FAILED', attempts: 7 });
  });

  it('makes the crash of the final attempt terminal instead of permanently PROCESSING', async () => {
    const row = await event(1);
    const first = start('hold');
    await first.publishing;
    const exited = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await exited;
    await expire(row.id);
    let deliveries = 0;
    await publisher(() => {
      deliveries++;
      return Promise.resolve();
    }).publishPendingEvents();
    expect(deliveries).toBe(0);
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it('retries identical delivery when the broker accepted it but DB completion failed', async () => {
    const row = await event();
    const deliveries: unknown[][] = [];
    const worker = publisher((...args) => {
      deliveries.push(args);
      return Promise.resolve();
    });
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION reject_outbox_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'injected completion failure'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_outbox_completion BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION reject_outbox_completion()`,
    );
    try {
      await worker.publishPendingEvents();
      expect(
        (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe('PROCESSING');
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER reject_outbox_completion ON outbox_events',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION reject_outbox_completion()',
      );
    }
    await expire(row.id);
    await recoverAndRetry(worker, row.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      status: 'COMPLETED',
      attempts: 2,
      payload: row.payload,
      createdAt: row.createdAt,
    });
  });

  it('starts only the claimed concurrency-sized wave and drains more than one batch across ticks', async () => {
    for (let index = 0; index < 53; index++) await event();
    const release = deferred<void>();
    const entered = deferred<void>();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const worker = publisher(async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      if (calls === 2) entered.resolve();
      await release.promise;
      active--;
    });
    const first = worker.publishPendingEvents();
    await entered.promise;
    expect(
      await prisma.outboxEvent.count({ where: { status: 'PROCESSING' } }),
    ).toBe(2);
    expect(
      await prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
    ).toBe(51);
    await worker.publishPendingEvents(); // Same instance must not overlap itself.
    release.resolve();
    await first;
    await worker.publishPendingEvents();
    expect(peak).toBe(2);
    expect(calls).toBe(53);
    expect(
      await prisma.outboxEvent.count({
        where: { status: 'COMPLETED', attempts: 1 },
      }),
    ).toBe(53);
  });

  it('recovers expired claims despite a backlog of exhausted legacy PENDING rows', async () => {
    for (let index = 0; index < 53; index++) {
      const row = await event(2);
      // The old publisher used a fixed budget of 5, ignoring this row's budget.
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { attempts: 2 },
      });
    }
    const expired = await event(1);
    await prisma.outboxEvent.update({
      where: { id: expired.id },
      data: {
        status: 'PROCESSING',
        attempts: 1,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(0),
      },
    });
    const deferredRow = await event();
    await prisma.outboxEvent.update({
      where: { id: deferredRow.id },
      data: { nextAttemptAt: new Date(Date.now() + 86400000) },
    });
    const untouched = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: deferredRow.id },
    });
    let deliveries = 0;
    const worker = publisher(() => {
      deliveries++;
      return Promise.resolve();
    });
    await worker.publishPendingEvents();
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: expired.id },
      }),
    ).toMatchObject({ status: 'FAILED', attempts: 1, leaseToken: null });
    await worker.publishPendingEvents();
    expect(
      await prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
    ).toBe(54);
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: deferredRow.id },
      }),
    ).toEqual(untouched);
    await worker.publishPendingEvents(); // An empty recovery tick is a no-op.
    expect(
      await prisma.outboxEvent.findUniqueOrThrow({
        where: { id: deferredRow.id },
      }),
    ).toEqual(untouched);
    expect(deliveries).toBe(0);
  });

  it('does not automatically replay legacy PROCESSING rows without a claim token', async () => {
    const row = await event();
    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: { status: 'PROCESSING' },
    });
    let calls = 0;
    await publisher(() => {
      calls++;
      return Promise.resolve();
    }).publishPendingEvents();
    expect(calls).toBe(0);
    expect(
      (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe('PROCESSING');
  });
});
