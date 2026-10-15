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
import { Pool } from 'pg';
import { PrismaService } from 'src/prisma/prisma.service';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { LoyaltyExpirationService } from 'src/loyalty/loyalty-expiration.service';
import { LoyaltyCalculatorService } from 'src/loyalty/loyalty-calculator.service';
import { AchievementsService } from 'src/achievements/achievements.service';
import { INJECTION_TOKENS } from 'src/loyalty/constants/loyalty.constants';
import { EventType } from 'src/loyalty/enums/event-type.enum';
import { AchievementsProcessor } from 'src/achievements/processors/achievements.processor';
import { AchievementAction } from 'src/achievements/enums/achievement-action.enum';

type Operation = 'deduct' | 'refund';
type Request = { userId: string; amount: number; orderId: string; key: string };

describe('Deduct/refund idempotency on PostgreSQL', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let loyalty: LoyaltyService;
  let expiration: LoyaltyExpirationService;
  let observer: Pool;
  let request: Request;
  let otherUserId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
    if (!databaseUrl) throw new Error('Run bun run test:integration');
    const url = new URL(databaseUrl);
    if (
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/loyalty_integration' ||
      url.username !== 'loyalty_test'
    )
      throw new Error('Disposable local database required');
    observer = new Pool({ connectionString: databaseUrl });
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        LoyaltyService,
        LoyaltyExpirationService,
        LoyaltyCalculatorService,
        AchievementsProcessor,
        {
          provide: ConfigService,
          useValue: new ConfigService({ DATABASE_URL: databaseUrl }),
        },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: AchievementsService, useValue: {} },
        { provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT, useValue: {} },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    loyalty = module.get(LoyaltyService);
    expiration = module.get(LoyaltyExpirationService);
    await prisma.$connect();
  });
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE loyalty_profiles, points_transactions, processed_events, achievements, user_achievements CASCADE`;
    request = {
      userId: randomUUID(),
      amount: 80,
      orderId: randomUUID(),
      key: randomUUID(),
    };
    otherUserId = randomUUID();
    await prisma.loyaltyProfile.createMany({
      data: [
        { userId: request.userId, balance: 500 },
        { userId: otherUserId, balance: 500 },
      ],
    });
  });
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (module) await module.close();
    if (observer) await observer.end();
  });
  function invoke(operation: Operation, data = request) {
    return operation === 'deduct'
      ? loyalty.deductPoints(data.userId, data.amount, data.orderId, data.key)
      : expiration.refundPoints(
          data.userId,
          data.amount,
          data.orderId,
          data.key,
        );
  }
  function profile(userId = request.userId) {
    return prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } });
  }
  async function overlap<T, U>(
    users: string[],
    first: () => Promise<T>,
    second: () => Promise<U>,
  ): Promise<[T, U]> {
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM loyalty_profiles WHERE user_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [users],
    );
    const work = Promise.allSettled([first(), second()]);
    try {
      const deadline = Date.now() + 5000;
      let overlapping = false;
      while (Date.now() < deadline) {
        const result = await observer.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%loyalty_profiles%' AND pid <> pg_backend_pid()`,
        );
        if (result.rows[0].count >= 2) {
          overlapping = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(overlapping).toBe(true);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await work;
    }
    const [one, two] = await work;
    if (one.status === 'rejected') throw one.reason;
    if (two.status === 'rejected') throw two.reason;
    return [one.value, two.value];
  }

  it.each<Operation>(['deduct', 'refund'])(
    'replays the original %s result after a committed response was lost and balance changed',
    async (operation) => {
      const original = await invoke(operation); // Commit occurred, caller loses this response.
      expect(original.success).toBe(true);
      await invoke(operation === 'deduct' ? 'refund' : 'deduct', {
        ...request,
        key: randomUUID(),
        orderId: randomUUID(),
      });
      const beforeReplay = await profile();
      expect(await invoke(operation)).toEqual(original);
      expect(await profile()).toEqual(beforeReplay);
      expect(await prisma.pointsTransaction.count()).toBe(2);
    },
  );

  describe.each<Operation>(['deduct', 'refund'])(
    '%s payload binding',
    (operation) => {
      it.each(['user', 'order', 'amount'])(
        'rejects reuse for a different %s',
        async (changed) => {
          expect((await invoke(operation)).success).toBe(true);
          const profiles = await prisma.loyaltyProfile.findMany({
            orderBy: { id: 'asc' },
          });
          const modified = {
            ...request,
            ...(changed === 'user'
              ? { userId: otherUserId }
              : changed === 'order'
                ? { orderId: randomUUID() }
                : { amount: 100 }),
          };
          const result = await invoke(operation, modified);
          expect(result).toMatchObject({ success: false, balanceAfter: 0 });
          expect(result.errorMessage).toContain('Idempotency');
          expect(
            await prisma.loyaltyProfile.findMany({ orderBy: { id: 'asc' } }),
          ).toEqual(profiles);
          expect(await prisma.pointsTransaction.count()).toBe(1);
        },
      );

      it('treats UUID casing as the same request and the opaque key as case sensitive', async () => {
        request.key = 'Opaque-Key';
        const original = await invoke(operation);
        expect(
          await invoke(operation, {
            ...request,
            userId: request.userId.toUpperCase(),
            orderId: request.orderId.toUpperCase(),
          }),
        ).toEqual(original);
        expect(await prisma.pointsTransaction.count()).toBe(1);
        expect(
          (await invoke(operation, { ...request, key: 'opaque-key' })).success,
        ).toBe(true);
        expect(await prisma.pointsTransaction.count()).toBe(2);
      });

      it('returns the stored result even if the profile has since been removed', async () => {
        const original = await invoke(operation);
        await prisma.loyaltyProfile.delete({
          where: { userId: request.userId },
        });
        expect(await invoke(operation)).toEqual(original);
        expect(await prisma.pointsTransaction.count()).toBe(1);
      });

      it('deduplicates genuinely overlapping repeats', async () => {
        const results = await overlap(
          [request.userId],
          () => invoke(operation),
          () => invoke(operation),
        );
        expect(results[0]).toEqual(results[1]);
        expect(results[0].success).toBe(true);
        expect(await prisma.pointsTransaction.count()).toBe(1);
        expect(await prisma.processedEvent.count()).toBe(1);
      });

      it('resolves a global key collision between two different users without a second effect', async () => {
        const results = await overlap(
          [request.userId, otherUserId],
          () => invoke(operation),
          () => invoke(operation, { ...request, userId: otherUserId }),
        );
        expect(results.filter((result) => result.success)).toHaveLength(1);
        expect(
          results.find((result) => !result.success)?.errorMessage,
        ).toContain('Idempotency');
        expect(await prisma.pointsTransaction.count()).toBe(1);
        expect(await prisma.processedEvent.count()).toBe(1);
        const balances = (await prisma.loyaltyProfile.findMany())
          .map((row) => row.balance)
          .sort((a, b) => a - b);
        expect(balances).toEqual(
          operation === 'deduct' ? [420, 500] : [500, 580],
        );
      });

      it('rolls back profile, ledger and request/result record on a ledger failure', async () => {
        const before = await profile();
        await observer.query(
          `CREATE FUNCTION reject_point_command_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected point ledger failure'; END $$`,
        );
        await observer.query(
          'CREATE TRIGGER reject_point_command_ledger AFTER INSERT ON points_transactions FOR EACH ROW EXECUTE FUNCTION reject_point_command_ledger()',
        );
        try {
          expect((await invoke(operation)).success).toBe(false);
          expect(await profile()).toEqual(before);
          expect(await prisma.pointsTransaction.count()).toBe(0);
          expect(await prisma.processedEvent.count()).toBe(0);
        } finally {
          await observer.query(
            'DROP TRIGGER reject_point_command_ledger ON points_transactions',
          );
          await observer.query('DROP FUNCTION reject_point_command_ledger()');
        }
        expect((await invoke(operation)).success).toBe(true);
        expect(await prisma.pointsTransaction.count()).toBe(1);
      });

      it('refuses an unverifiable legacy or generic-event key without inventing a success', async () => {
        await prisma.processedEvent.create({ data: { eventId: request.key } });
        const before = await profile();
        const result = await invoke(operation);
        expect(result).toMatchObject({ success: false, balanceAfter: 0 });
        expect(result.errorMessage).toContain('legacy');
        expect(await profile()).toEqual(before);
        expect(await prisma.pointsTransaction.count()).toBe(0);
      });
    },
  );

  it.each<Operation>(['deduct', 'refund'])(
    'rejects using a committed %s key for the other operation',
    async (operation) => {
      await invoke(operation);
      const result = await invoke(operation === 'deduct' ? 'refund' : 'deduct');
      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('Idempotency');
      expect(await prisma.pointsTransaction.count()).toBe(1);
    },
  );

  it('replays a committed debit after compensation without deducting a second time', async () => {
    const debit = await invoke('deduct');
    const refundRequest = { ...request, key: randomUUID() };
    const refund = await invoke('refund', refundRequest);
    expect(await invoke('deduct')).toEqual(debit);
    expect(await invoke('refund', refundRequest)).toEqual(refund);
    expect((await profile()).balance).toBe(500);
    expect(await prisma.pointsTransaction.count()).toBe(2);
  });

  it('preserves retries after an insufficient-balance rejection that made no committed effect', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId: request.userId },
      data: { balance: 50 },
    });
    expect((await invoke('deduct')).success).toBe(false);
    expect(await prisma.processedEvent.count()).toBe(0);
    await invoke('refund', { ...request, amount: 40, key: randomUUID() });
    expect(await invoke('deduct')).toMatchObject({
      success: true,
      balanceAfter: 10,
    });
  });

  it('does not treat a command key as an already processed purchase event', async () => {
    await invoke('deduct');
    const before = await profile();
    await expect(
      loyalty.processTicketPurchase({
        userId: request.userId,
        eventId: request.key,
        orderId: randomUUID(),
        totalAmount: 10,
        ticketAmount: 10,
        foodAmount: 0,
        eventType: EventType.STANDARD,
        purchasedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('Idempotency');
    expect(await profile()).toEqual(before);
    expect(await prisma.pointsTransaction.count()).toBe(1);
  });

  it('characterizes existing refund policy: distinct keys can credit one order without a linked debit', async () => {
    expect((await invoke('refund')).success).toBe(true);
    expect(
      (await invoke('refund', { ...request, key: randomUUID() })).success,
    ).toBe(true);
    expect((await profile()).balance).toBe(660);
    expect(await prisma.pointsTransaction.count()).toBe(2);
  });

  it('does not silently skip an achievement when its dedupe key collides with a point command', async () => {
    const achievement = await prisma.achievement.create({
      data: {
        code: 'COMMAND_COLLISION',
        name: 'Test',
        description: 'Test',
        icon: 'test',
        category: 'VISITS',
        strategy: 'THRESHOLD',
        criteria: { field: 'TICKET_PURCHASED', operator: 'gte', target: 1 },
        rewardPoints: 30,
      },
    });
    const eventId = randomUUID();
    request.key = `${eventId}_${achievement.id}`;
    await invoke('deduct');
    const before = await profile();
    await expect(
      module.get(AchievementsProcessor).process({
        id: eventId,
        name: 'test',
        queueName: 'test',
        data: {
          eventId,
          userId: request.userId,
          actionType: AchievementAction.TICKET_PURCHASED,
        },
      }),
    ).rejects.toThrow('Idempotency');
    expect(await profile()).toEqual(before);
    expect(await prisma.userAchievement.count()).toBe(0);
  });

  it('checks an existing key before rejecting a changed deduction amount below the minimum', async () => {
    await invoke('deduct');
    expect(
      (await invoke('deduct', { ...request, amount: 30 })).errorMessage,
    ).toContain('Idempotency');
    expect(await prisma.pointsTransaction.count()).toBe(1);
  });

  it.each([
    'empty key',
    'long key',
    'invalid user',
    'invalid order',
    'zero refund',
    'negative refund',
  ])('rejects %s without binding a key or changing money', async (invalid) => {
    const modified = {
      ...request,
      ...(invalid === 'empty key' ? { key: '' } : {}),
      ...(invalid === 'long key' ? { key: 'x'.repeat(129) } : {}),
      ...(invalid === 'invalid user' ? { userId: 'invalid' } : {}),
      ...(invalid === 'invalid order' ? { orderId: 'invalid' } : {}),
      ...(invalid === 'zero refund' ? { amount: 0 } : {}),
      ...(invalid === 'negative refund' ? { amount: -80 } : {}),
    };
    expect(await invoke('refund', modified)).toMatchObject({
      success: false,
      balanceAfter: 0,
    });
    expect((await profile()).balance).toBe(500);
    expect(await prisma.processedEvent.count()).toBe(0);
    expect(await prisma.pointsTransaction.count()).toBe(0);
  });
});
