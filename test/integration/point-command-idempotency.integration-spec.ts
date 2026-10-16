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
  const fixtureDebits: string[] = [];

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
    fixtureDebits.length = 0;
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
  async function prepareRefund(userId = request.userId) {
    // A prior registered debit ending at the fixture's starting balance of 500.
    const debit = await prisma.pointsTransaction.create({
      data: {
        userId,
        orderId: request.orderId,
        type: 'BURN_DISCOUNT',
        points: -request.amount,
        balanceAfter: 500,
      },
    });
    await prisma.checkoutDebit.create({ data: { debitId: debit.id } });
    fixtureDebits.push(debit.id);
    return debit;
  }
  function effectLedgerCount() {
    return prisma.pointsTransaction.count({
      where: { id: { notIn: fixtureDebits } },
    });
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
      if (operation === 'refund') await prepareRefund();
      const original = await invoke(operation); // Commit occurred, caller loses this response.
      expect(original.success).toBe(true);
      await invoke('deduct', {
        ...request,
        key: randomUUID(),
        orderId: randomUUID(),
      });
      const beforeReplay = await profile();
      expect(await invoke(operation)).toEqual(original);
      expect(await profile()).toEqual(beforeReplay);
      expect(await effectLedgerCount()).toBe(2);
    },
  );

  describe.each<Operation>(['deduct', 'refund'])(
    '%s payload binding',
    (operation) => {
      beforeEach(async () => {
        if (operation === 'refund') {
          await prepareRefund();
          await prepareRefund(otherUserId);
        }
      });
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
          expect(await effectLedgerCount()).toBe(1);
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
        expect(await effectLedgerCount()).toBe(1);
        expect(
          (await invoke(operation, { ...request, key: 'opaque-key' })).success,
        ).toBe(operation === 'deduct');
        expect(await effectLedgerCount()).toBe(operation === 'deduct' ? 2 : 1);
      });

      it('returns the stored result even if the profile has since been removed', async () => {
        const original = await invoke(operation);
        await prisma.loyaltyProfile.delete({
          where: { userId: request.userId },
        });
        expect(await invoke(operation)).toEqual(original);
        expect(await effectLedgerCount()).toBe(1);
      });

      it('deduplicates genuinely overlapping repeats', async () => {
        const results = await overlap(
          [request.userId],
          () => invoke(operation),
          () => invoke(operation),
        );
        expect(results[0]).toEqual(results[1]);
        expect(results[0].success).toBe(true);
        expect(await effectLedgerCount()).toBe(1);
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
        expect(await effectLedgerCount()).toBe(1);
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
          expect(await effectLedgerCount()).toBe(0);
          expect(await prisma.processedEvent.count()).toBe(0);
        } finally {
          await observer.query(
            'DROP TRIGGER reject_point_command_ledger ON points_transactions',
          );
          await observer.query('DROP FUNCTION reject_point_command_ledger()');
        }
        expect((await invoke(operation)).success).toBe(true);
        expect(await effectLedgerCount()).toBe(1);
      });

      it('refuses an unverifiable legacy or generic-event key without inventing a success', async () => {
        await prisma.processedEvent.create({ data: { eventId: request.key } });
        const before = await profile();
        const result = await invoke(operation);
        expect(result).toMatchObject({ success: false, balanceAfter: 0 });
        expect(result.errorMessage).toContain('legacy');
        expect(await profile()).toEqual(before);
        expect(await effectLedgerCount()).toBe(0);
      });
    },
  );

  it.each<Operation>(['deduct', 'refund'])(
    'rejects using a committed %s key for the other operation',
    async (operation) => {
      if (operation === 'refund') await prepareRefund();
      await invoke(operation);
      const result = await invoke(operation === 'deduct' ? 'refund' : 'deduct');
      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('Idempotency');
      expect(await effectLedgerCount()).toBe(1);
    },
  );

  it('replays a committed debit after compensation without deducting a second time', async () => {
    const debit = await invoke('deduct');
    const refundRequest = { ...request, key: randomUUID() };
    const refund = await invoke('refund', refundRequest);
    expect(await invoke('deduct')).toEqual(debit);
    expect(await invoke('refund', refundRequest)).toEqual(refund);
    expect((await profile()).balance).toBe(500);
    expect(await effectLedgerCount()).toBe(2);
  });

  it('preserves retries after an insufficient-balance rejection that made no committed effect', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId: request.userId },
      data: { balance: 50 },
    });
    expect((await invoke('deduct')).success).toBe(false);
    expect(await prisma.processedEvent.count()).toBe(0);
    await prisma.loyaltyProfile.update({
      where: { userId: request.userId },
      data: { balance: { increment: 40 } },
    });
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
    expect(await effectLedgerCount()).toBe(1);
  });

  it('rejects refund without a debit', async () => {
    expect((await invoke('refund')).success).toBe(false);
    expect((await profile()).balance).toBe(500);
    expect(await effectLedgerCount()).toBe(0);
  });

  it('rejects concurrent refunds with different keys after one full compensation', async () => {
    await invoke('deduct', { ...request, key: randomUUID() });
    const results = await overlap(
      [request.userId],
      () => invoke('refund'),
      () => invoke('refund', { ...request, key: randomUUID() }),
    );
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect((await profile()).balance).toBe(500);
    expect(
      await prisma.pointsTransaction.count({ where: { type: 'REFUND' } }),
    ).toBe(1);
    expect(await prisma.processedEvent.count()).toBe(2);
  });

  describe('full checkout compensation', () => {
    beforeEach(async () => {
      expect(
        (await invoke('deduct', { ...request, key: randomUUID() })).success,
      ).toBe(true);
    });

    it('rolls back a new debit if its compensation registry insert fails', async () => {
      const next = { ...request, orderId: randomUUID(), key: randomUUID() };
      const before = await profile();
      await observer.query(
        `CREATE FUNCTION reject_debit_registration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected debit registry failure'; END $$`,
      );
      await observer.query(
        'CREATE TRIGGER reject_debit_registration AFTER INSERT ON checkout_debits FOR EACH ROW EXECUTE FUNCTION reject_debit_registration()',
      );
      try {
        expect((await invoke('deduct', next)).success).toBe(false);
        expect(await profile()).toEqual(before);
        expect(await effectLedgerCount()).toBe(1);
        expect(await prisma.processedEvent.count()).toBe(1);
        expect(await prisma.checkoutDebit.count()).toBe(1);
      } finally {
        await observer.query(
          'DROP TRIGGER reject_debit_registration ON checkout_debits',
        );
        await observer.query('DROP FUNCTION reject_debit_registration()');
      }
      expect((await invoke('deduct', next)).success).toBe(true);
      expect(await prisma.checkoutDebit.count()).toBe(2);
    });

    it.each(['smaller amount', 'larger amount', 'other user', 'other order'])(
      'rejects %s without any refund effect',
      async (changed) => {
        const modified = {
          ...request,
          amount:
            changed === 'smaller amount'
              ? 79
              : changed === 'larger amount'
                ? 81
                : 80,
          userId: changed === 'other user' ? otherUserId : request.userId,
          orderId: changed === 'other order' ? randomUUID() : request.orderId,
        };
        const before = await prisma.loyaltyProfile.findMany({
          orderBy: { id: 'asc' },
        });
        expect((await invoke('refund', modified)).success).toBe(false);
        expect(
          await prisma.loyaltyProfile.findMany({ orderBy: { id: 'asc' } }),
        ).toEqual(before);
        expect(await effectLedgerCount()).toBe(1);
        expect(await prisma.processedEvent.count()).toBe(1);
        expect(
          (await prisma.checkoutDebit.findFirstOrThrow()).refundId,
        ).toBeNull();
      },
    );

    it('links one full refund and replays its historical result after loss of the response', async () => {
      const debit = await prisma.checkoutDebit.findFirstOrThrow();
      const first = await invoke('refund');
      expect(first).toMatchObject({ success: true, balanceAfter: 500 });
      const linked = await prisma.checkoutDebit.findUniqueOrThrow({
        where: { debitId: debit.debitId },
      });
      expect(
        await prisma.pointsTransaction.findUniqueOrThrow({
          where: { id: linked.refundId ?? '' },
        }),
      ).toMatchObject({
        type: 'REFUND',
        points: 80,
        userId: request.userId,
        orderId: request.orderId,
      });
      await prisma.loyaltyProfile.update({
        where: { userId: request.userId },
        data: { balance: { increment: 25 } },
      });
      expect(await invoke('refund')).toEqual(first);
      expect(
        (await invoke('refund', { ...request, key: randomUUID() }))
          .errorMessage,
      ).toContain('already been compensated');
      expect((await profile()).balance).toBe(525);
      expect(await effectLedgerCount()).toBe(2);
    });

    it('rolls back profile, refund ledger, link and idempotency result when linking fails', async () => {
      const before = await profile();
      await observer.query(
        `CREATE FUNCTION reject_refund_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected refund link failure'; END $$`,
      );
      await observer.query(
        'CREATE TRIGGER reject_refund_link AFTER UPDATE ON checkout_debits FOR EACH ROW EXECUTE FUNCTION reject_refund_link()',
      );
      try {
        expect((await invoke('refund')).success).toBe(false);
        expect(await profile()).toEqual(before);
        expect(await effectLedgerCount()).toBe(1);
        expect(await prisma.processedEvent.count()).toBe(1);
        expect(
          (await prisma.checkoutDebit.findFirstOrThrow()).refundId,
        ).toBeNull();
      } finally {
        await observer.query(
          'DROP TRIGGER reject_refund_link ON checkout_debits',
        );
        await observer.query('DROP FUNCTION reject_refund_link()');
      }
      expect((await invoke('refund')).success).toBe(true);
    });

    it('requires explicit reconciliation of a legacy debit and then allows the approved full refund', async () => {
      const debit = await prisma.checkoutDebit.findFirstOrThrow();
      await prisma.checkoutDebit.deleteMany(); // Simulates a pre-registry ledger.
      expect((await invoke('refund')).errorMessage).toContain('reconciliation');
      expect((await profile()).balance).toBe(420);
      expect(await prisma.processedEvent.count()).toBe(1);
      // Operator has verified there is no previous credit, then registers eligibility.
      await prisma.checkoutDebit.create({ data: { debitId: debit.debitId } });
      expect((await invoke('refund')).success).toBe(true);
    });

    it('does not credit again when an unlinked legacy refund exists', async () => {
      await prisma.pointsTransaction.create({
        data: {
          userId: request.userId,
          orderId: request.orderId,
          type: 'REFUND',
          points: 80,
          balanceAfter: 500,
        },
      });
      await prisma.loyaltyProfile.update({
        where: { userId: request.userId },
        data: { balance: 500 },
      });
      expect((await invoke('refund')).errorMessage).toContain(
        'already been compensated',
      );
      expect((await profile()).balance).toBe(500);
      expect(await effectLedgerCount()).toBe(2);
    });

    it('refuses ambiguous multiple debits for one checkout order', async () => {
      await invoke('deduct', { ...request, key: randomUUID() });
      expect((await invoke('refund')).errorMessage).toContain('reconciliation');
      expect((await profile()).balance).toBe(340);
      expect(await effectLedgerCount()).toBe(2);
    });

    it('keeps exact replay of a pre-registry successful refund result', async () => {
      await prisma.checkoutDebit.deleteMany();
      await prisma.pointsTransaction.create({
        data: {
          userId: request.userId,
          orderId: request.orderId,
          type: 'REFUND',
          points: 80,
          balanceAfter: 500,
        },
      });
      await prisma.processedEvent.create({
        data: {
          eventId: request.key,
          operation: 'REFUND',
          userId: request.userId,
          orderId: request.orderId,
          amount: 80,
          balanceAfter: 500,
        },
      });
      await prisma.loyaltyProfile.update({
        where: { userId: request.userId },
        data: { balance: 500 },
      });
      expect(await invoke('refund')).toEqual({
        success: true,
        balanceAfter: 500,
        errorMessage: '',
      });
      expect((await profile()).balance).toBe(500);
      expect(await effectLedgerCount()).toBe(2);
    });
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
    expect(await effectLedgerCount()).toBe(1);
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
    expect(await effectLedgerCount()).toBe(0);
  });
});
