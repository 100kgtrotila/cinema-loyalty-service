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
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { EventEmitter2 } from 'eventemitter2';
import { PrismaService } from 'src/prisma/prisma.service';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { LoyaltyCalculatorService } from 'src/loyalty/loyalty-calculator.service';
import { AchievementsService } from 'src/achievements/achievements.service';
import { LoyaltyExpirationService } from 'src/loyalty/loyalty-expiration.service';
import { AdminLoyaltyService } from 'src/loyalty/admin-loyalty.service';
import { AchievementsProcessor } from 'src/achievements/processors/achievements.processor';
import { INJECTION_TOKENS } from 'src/loyalty/constants/loyalty.constants';
import { EventType } from 'src/loyalty/enums/event-type.enum';
import { TicketPurchasedDto } from 'src/loyalty/dto/ticked-purchased.dto';
import { AchievementAction } from 'src/achievements/enums/achievement-action.enum';
import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';
import { withTransactionRetry } from 'src/prisma/profile-transaction';
import { getQueueToken } from '@nestjs/bullmq';
import { ACHIEVEMENTS_QUEUE } from 'src/achievements/constants/achievements.constants';
import { AchievementMapper } from 'src/achievements/mappers/achievement.mapper';
import { AchievementIntentPublisher } from 'src/achievements/achievement-intent-publisher.service';

describe('Profile concurrency on PostgreSQL', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let loyalty: LoyaltyService;
  let expiration: LoyaltyExpirationService;
  let admin: AdminLoyaltyService;
  let achievements: AchievementsProcessor;
  let observer: Pool;
  let userId: string;
  let publisher: AchievementIntentPublisher;
  let redisReady = true;
  let enqueueHangs = false;
  const queuedIds: string[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
    if (!databaseUrl) throw new Error('Run through bun run test:integration');
    const parsedUrl = new URL(databaseUrl);
    if (
      parsedUrl.hostname !== '127.0.0.1' ||
      parsedUrl.pathname !== '/loyalty_integration' ||
      parsedUrl.username !== 'loyalty_test'
    ) {
      throw new Error(
        'Integration tests require the disposable local PostgreSQL database',
      );
    }
    observer = new Pool({ connectionString: databaseUrl });
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        LoyaltyService,
        LoyaltyCalculatorService,
        LoyaltyExpirationService,
        AdminLoyaltyService,
        AchievementsProcessor,
        AchievementsService,
        AchievementMapper,
        AchievementIntentPublisher,
        { provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT, useValue: {} },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            DATABASE_URL: databaseUrl,
            app: { outboxPublishTimeoutMs: 30 },
          }),
        },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        {
          provide: getQueueToken(ACHIEVEMENTS_QUEUE),
          useValue: {
            get client() {
              return Promise.resolve({
                status: redisReady ? 'ready' : 'reconnecting',
              });
            },
            add: (
              _name: string,
              _data: unknown,
              options: { jobId: string },
            ) => {
              queuedIds.push(options.jobId);
              if (enqueueHangs) return new Promise<never>(() => {});
              return Promise.resolve({ id: options.jobId });
            },
          },
        },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    loyalty = module.get(LoyaltyService);
    expiration = module.get(LoyaltyExpirationService);
    admin = module.get(AdminLoyaltyService);
    achievements = module.get(AchievementsProcessor);
    publisher = module.get(AchievementIntentPublisher);
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE loyalty_profiles, points_transactions, processed_events, outbox_events, achievement_dispatch_intents, user_bonus_grants, achievements, user_achievements CASCADE`;
    userId = randomUUID();
    redisReady = true;
    enqueueHangs = false;
    queuedIds.length = 0;
    await prisma.loyaltyProfile.create({ data: { userId, balance: 100 } });
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (module) await module.close();
    if (observer) await observer.end();
  });

  // Hold the real profile row, start both operations, and prove that both DB
  // sessions are waiting for a lock before releasing it. No timing-only barrier.
  async function overlap<T, U>(
    first: () => Promise<T>,
    second: () => Promise<U>,
  ): Promise<[T, U]> {
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM loyalty_profiles WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const operations = Promise.allSettled([first(), second()]);
    let barrierError: unknown;
    try {
      await waitForBlockedWriters(2);
    } catch (error: unknown) {
      barrierError = error;
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const [one, two] = await operations;
    if (barrierError) {
      throw barrierError instanceof Error
        ? barrierError
        : new Error('Concurrency barrier failed', { cause: barrierError });
    }
    if (one.status === 'rejected') throw one.reason;
    if (two.status === 'rejected') throw two.reason;
    return [one.value, two.value];
  }

  async function waitForBlockedWriters(count: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE '%loyalty_profiles%' AND pid <> pg_backend_pid()`,
      );
      if (result.rows[0].count >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Did not observe ${count} overlapping profile writers`);
  }

  function purchase(amount: number): TicketPurchasedDto {
    return {
      userId,
      eventId: randomUUID(),
      orderId: randomUUID(),
      totalAmount: amount,
      ticketAmount: amount,
      foodAmount: 0,
      eventType: EventType.STANDARD,
      purchasedAt: new Date().toISOString(),
      pointsUsed: 0,
    };
  }

  async function profile() {
    return prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } });
  }

  async function ledger() {
    return prisma.pointsTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  it('commits purchase and both VIP achievement intents once without contacting Redis', async () => {
    redisReady = false;
    const event = { ...purchase(100), seatClass: 'VIP' };
    await overlap(
      () => loyalty.processTicketPurchase(event),
      () => loyalty.processTicketPurchase(event),
    );
    const intents = await prisma.achievementDispatchIntent.findMany({
      orderBy: { actionType: 'asc' },
    });
    expect(intents).toEqual([
      expect.objectContaining({
        eventId: event.orderId,
        userId,
        actionType: 'TICKET_PURCHASED',
        deliveredAt: null,
      }),
      expect.objectContaining({
        eventId: `${event.orderId}_vip`,
        userId,
        actionType: 'VIP_SEAT_BOUGHT',
        deliveredAt: null,
      }),
    ]);
    expect(intents[0].payload).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ seatClass: 'VIP', amount: 100 }),
      }),
    );
    expect((await profile()).yearVisits).toBe(1);
    expect(await ledger()).toHaveLength(1);
    expect(queuedIds).toHaveLength(0);
  });

  it('rolls back purchase, ledger, tier outbox and dedupe if saving an intent fails', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { yearPoints: 1999 },
    });
    const before = await profile();
    await observer.query(`CREATE FUNCTION reject_intent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected intent failure'; END $$`);
    await observer.query(
      'CREATE TRIGGER reject_intent AFTER INSERT ON achievement_dispatch_intents FOR EACH ROW EXECUTE FUNCTION reject_intent()',
    );
    try {
      await expect(
        loyalty.processTicketPurchase(purchase(10)),
      ).rejects.toThrow();
      expect(await profile()).toEqual(before);
      expect(await ledger()).toHaveLength(0);
      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(await prisma.processedEvent.count()).toBe(0);
      expect(await prisma.achievementDispatchIntent.count()).toBe(0);
    } finally {
      await observer.query(
        'DROP TRIGGER reject_intent ON achievement_dispatch_intents',
      );
      await observer.query('DROP FUNCTION reject_intent()');
    }
  });

  it('keeps failed delivery pending and retries with a stable BullMQ job id', async () => {
    await loyalty.processTicketPurchase(purchase(100));
    redisReady = false;
    await publisher.publishPendingIntents();
    const pending = await prisma.achievementDispatchIntent.findFirstOrThrow();
    expect(pending).toEqual(
      expect.objectContaining({
        deliveredAt: null,
        attempts: 1,
        error: 'Achievement Redis is unavailable',
      }),
    );
    expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(queuedIds).toHaveLength(0);
    redisReady = true;
    // Simulate queue acceptance followed by failure to record delivery in PostgreSQL.
    await observer.query(`CREATE FUNCTION reject_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.delivered_at IS NOT NULL THEN RAISE EXCEPTION 'injected delivery mark failure'; END IF; RETURN NEW; END $$`);
    await observer.query(
      'CREATE TRIGGER reject_delivery BEFORE UPDATE ON achievement_dispatch_intents FOR EACH ROW EXECUTE FUNCTION reject_delivery()',
    );
    try {
      await prisma.achievementDispatchIntent.update({
        where: { id: pending.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await publisher.publishPendingIntents();
      expect(
        (
          await prisma.achievementDispatchIntent.findUniqueOrThrow({
            where: { id: pending.id },
          })
        ).deliveredAt,
      ).toBeNull();
    } finally {
      await observer.query(
        'DROP TRIGGER reject_delivery ON achievement_dispatch_intents',
      );
      await observer.query('DROP FUNCTION reject_delivery()');
    }
    await prisma.achievementDispatchIntent.update({
      where: { id: pending.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await publisher.publishPendingIntents();
    expect(queuedIds).toEqual([pending.id, pending.id]);
    expect(
      await prisma.achievementDispatchIntent.findUniqueOrThrow({
        where: { id: pending.id },
      }),
    ).toEqual(
      expect.objectContaining({
        deliveredAt: expect.any(Date),
        attempts: 3,
        error: null,
      }),
    );
  });

  it('leaves an enqueue timeout pending instead of marking it delivered', async () => {
    await loyalty.processTicketPurchase(purchase(100));
    enqueueHangs = true;
    await publisher.publishPendingIntents();
    expect(await prisma.achievementDispatchIntent.findFirstOrThrow()).toEqual(
      expect.objectContaining({
        deliveredAt: null,
        attempts: 1,
        error: expect.stringContaining('timed out'),
      }),
    );
  });

  it('allows only one of two overlapping 80-point deductions from 100', async () => {
    const results = await overlap(
      () => loyalty.deductPoints(userId, 80, randomUUID(), randomUUID()),
      () => loyalty.deductPoints(userId, 80, randomUUID(), randomUUID()),
    );
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)).toEqual({
      success: false,
      balanceAfter: 20,
      errorMessage: 'Insufficient points balance',
    });
    expect(
      (await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }))
        .balance,
    ).toBe(20);
    expect(
      await prisma.pointsTransaction.findMany({ where: { userId } }),
    ).toEqual([
      expect.objectContaining({
        points: -80,
        balanceAfter: 20,
        type: 'BURN_DISCOUNT',
      }),
    ]);
  });

  it('keeps both overlapping purchase awards and counters', async () => {
    await overlap(
      () => loyalty.processTicketPurchase(purchase(10)),
      () => loyalty.processTicketPurchase(purchase(20)),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 130,
        lifetimePoints: 30,
        yearPoints: 30,
        yearVisits: 2,
        tier: 'BRONZE',
      }),
    );
    const entries = await ledger();
    expect(entries).toHaveLength(2);
    expect(entries.map((row) => row.points).sort((a, b) => a - b)).toEqual([
      10, 20,
    ]);
    expect(entries.map((row) => row.balanceAfter)).toContain(130);
    expect((await profile()).balanceExpiresAt).toBeInstanceOf(Date);
  });

  it('preserves an award and a deduction for the same user', async () => {
    const [, deducted] = await overlap(
      () => loyalty.processTicketPurchase(purchase(50)),
      () => loyalty.deductPoints(userId, 80, randomUUID(), randomUUID()),
    );
    expect(deducted.success).toBe(true);
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 70,
        lifetimePoints: 50,
        yearPoints: 50,
        yearVisits: 1,
      }),
    );
    expect(
      (await ledger()).map((row) => row.points).sort((a, b) => a - b),
    ).toEqual([-80, 50]);
  });

  it('preserves a refund and a deduction for the same user', async () => {
    const results = await overlap(
      () => expiration.refundPoints(userId, 40, randomUUID(), randomUUID()),
      () => loyalty.deductPoints(userId, 80, randomUUID(), randomUUID()),
    );
    expect(results.every((result) => result.success)).toBe(true);
    expect((await profile()).balance).toBe(60);
    expect(
      (await ledger()).map((row) => row.points).sort((a, b) => a - b),
    ).toEqual([-80, 40]);
  });

  it('rejects one overlapping admin deduction without making the balance negative', async () => {
    const deduct = async () => {
      try {
        return await admin.modifyPointsGrpc(
          userId,
          'admin',
          -80,
          'integration',
        );
      } catch (error: unknown) {
        if (!(error instanceof RpcException)) throw error;
        expect(error.getError()).toEqual({
          code: GrpcStatus.INVALID_ARGUMENT,
          message: 'Insufficient points for deduction.',
        });
        return { success: false };
      }
    };
    const results = await overlap(deduct, deduct);
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect((await profile()).balance).toBe(20);
    expect(await ledger()).toEqual([
      expect.objectContaining({
        points: -80,
        balanceAfter: 20,
        type: 'ADMIN_DEDUCTION',
      }),
    ]);
  });

  async function achievementJob() {
    await prisma.achievement.create({
      data: {
        code: randomUUID(),
        name: 'Test reward',
        description: 'integration',
        icon: 'test',
        category: 'VISITS',
        strategy: 'INSTANT',
        rewardPoints: 30,
        criteria: {
          field: AchievementAction.REVIEW_LEFT,
          operator: 'gte',
          target: 1,
        },
      },
    });
    return {
      id: randomUUID(),
      name: 'process-achievement',
      queueName: 'achievements-queue',
      data: {
        userId,
        eventId: randomUUID(),
        actionType: AchievementAction.REVIEW_LEFT,
      },
    };
  }

  it('keeps achievement reward and purchase results without changing achievement earning rules', async () => {
    const job = await achievementJob();
    await overlap(
      () => achievements.process(job),
      () => loyalty.processTicketPurchase(purchase(10)),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 140,
        lifetimePoints: 40,
        yearPoints: 10,
        yearVisits: 1,
      }),
    );
    expect(
      (await ledger()).map((row) => row.points).sort((a, b) => a - b),
    ).toEqual([10, 30]);
    expect(
      await prisma.userAchievement.findMany({ where: { userId } }),
    ).toEqual([expect.objectContaining({ isUnlocked: true, current: 1 })]);
  });

  // Expiry first selects both candidates. It then waits on the first profile,
  // while a real mutation of the second candidate commits before expiry reads it.
  async function mutateAfterExpirySelection(
    mutate: () => Promise<unknown>,
  ): Promise<void> {
    const blockerUserId = randomUUID();
    await prisma.loyaltyProfile.create({
      data: {
        id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        userId: blockerUserId,
        balance: 1,
        balanceExpiresAt: new Date(0),
      },
    });
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { balanceExpiresAt: new Date(0) },
    });
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM loyalty_profiles WHERE user_id = $1 FOR UPDATE',
      [blockerUserId],
    );
    const expiring = expiration.expirePoints();
    const completion = Promise.allSettled([expiring]);
    try {
      await waitForBlockedWriters(1);
      await mutate();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await completion;
    }
    await expiring;
  }

  it('does not expire a top-up that extended the expiry after candidate selection', async () => {
    await mutateAfterExpirySelection(() =>
      loyalty.processTicketPurchase(purchase(50)),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 150,
        lifetimePoints: 50,
        yearPoints: 50,
        yearVisits: 1,
      }),
    );
    expect((await profile()).balanceExpiresAt?.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(await ledger()).toEqual([
      expect.objectContaining({ points: 50, balanceAfter: 150 }),
    ]);
  });

  it('expires the actual remaining balance after an overlapping deduction', async () => {
    await mutateAfterExpirySelection(async () => {
      expect(
        (await loyalty.deductPoints(userId, 80, randomUUID(), randomUUID()))
          .success,
      ).toBe(true);
    });
    expect((await profile()).balance).toBe(0);
    expect(await ledger()).toEqual([
      expect.objectContaining({ points: -80, balanceAfter: 20 }),
      expect.objectContaining({ points: -20, balanceAfter: 0, type: 'EXPIRE' }),
    ]);
  });

  it('rolls back profile, ledger, dedupe and outbox when outbox insertion fails', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { yearPoints: 1999 },
    });
    const event = purchase(10);
    await observer.query(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$`);
    await observer.query(
      'CREATE TRIGGER reject_outbox AFTER INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION reject_outbox()',
    );
    try {
      await expect(loyalty.processTicketPurchase(event)).rejects.toThrow();
      expect(await profile()).toEqual(
        expect.objectContaining({
          balance: 100,
          lifetimePoints: 0,
          yearPoints: 1999,
          yearVisits: 0,
          tier: 'BRONZE',
        }),
      );
      expect(await ledger()).toHaveLength(0);
      expect(await prisma.outboxEvent.count()).toBe(0);
      expect(await prisma.processedEvent.count()).toBe(0);
    } finally {
      await observer.query('DROP TRIGGER reject_outbox ON outbox_events');
      await observer.query('DROP FUNCTION reject_outbox()');
    }
    await loyalty.processTicketPurchase(event);
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 110,
        yearPoints: 2009,
        yearVisits: 1,
        tier: 'SILVER',
      }),
    );
    expect(await ledger()).toHaveLength(1);
    expect(await prisma.outboxEvent.findMany()).toEqual([
      expect.objectContaining({
        payload: { userId, oldTier: 'BRONZE', newTier: 'SILVER' },
      }),
    ]);
  });

  it('deduplicates two overlapping deductions with the same key', async () => {
    const orderId = randomUUID();
    const key = randomUUID();
    const deduct = () => loyalty.deductPoints(userId, 80, orderId, key);
    expect(
      (await overlap(deduct, deduct)).every((result) => result.success),
    ).toBe(true);
    expect((await profile()).balance).toBe(20);
    expect(await ledger()).toHaveLength(1);
    expect(await prisma.processedEvent.count()).toBe(1);
  });

  it('deduplicates overlapping purchases and their counters', async () => {
    const event = purchase(10);
    await overlap(
      () => loyalty.processTicketPurchase(event),
      () => loyalty.processTicketPurchase(event),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 110,
        lifetimePoints: 10,
        yearPoints: 10,
        yearVisits: 1,
      }),
    );
    expect(await ledger()).toHaveLength(1);
    expect(await prisma.processedEvent.count()).toBe(1);
  });

  it('deduplicates overlapping refunds', async () => {
    const orderId = randomUUID();
    const key = randomUUID();
    const refund = () => expiration.refundPoints(userId, 40, orderId, key);
    expect(
      (await overlap(refund, refund)).every((result) => result.success),
    ).toBe(true);
    expect((await profile()).balance).toBe(140);
    expect(await ledger()).toHaveLength(1);
    expect(await prisma.processedEvent.count()).toBe(1);
  });

  it('preserves birthday grant uniqueness during overlapping DOB events', async () => {
    const msg = {
      eventId: randomUUID(),
      userId,
      dateOfBirth: new Date().toISOString().slice(0, 10),
    };
    await overlap(
      () => loyalty.processUserDateOfBirthSet(msg),
      () => loyalty.processUserDateOfBirthSet(msg),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 200,
        lifetimePoints: 100,
        yearPoints: 100,
      }),
    );
    expect(await ledger()).toEqual([
      expect.objectContaining({
        type: 'EARN_BIRTHDAY',
        points: 100,
        balanceAfter: 200,
      }),
    ]);
    expect(await prisma.userBonusGrant.count()).toBe(1);
  });

  it('preserves achievement reward deduplication during overlapping events', async () => {
    const job = await achievementJob();
    await overlap(
      () => achievements.process(job),
      () => achievements.process(job),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 130,
        lifetimePoints: 30,
        yearPoints: 0,
      }),
    );
    expect(await ledger()).toHaveLength(1);
    expect(await prisma.userAchievement.findMany()).toEqual([
      expect.objectContaining({ isUnlocked: true, current: 1 }),
    ]);
    expect(await prisma.processedEvent.count()).toBe(1);
  });

  it('does not resurrect annual counters from a stale purchase snapshot', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { yearPoints: 10, yearVisits: 1 },
    });
    await overlap(
      () => expiration.resetAnnualStats(),
      () => loyalty.processTicketPurchase(purchase(10)),
    );
    const current = await profile();
    expect(current.balance).toBe(110);
    expect([0, 10]).toContain(current.yearPoints);
    expect(current.yearVisits).toBe(current.yearPoints === 0 ? 0 : 1);
    expect(await ledger()).toHaveLength(1);
  });

  it('calculates the next purchase from the tier and visits committed by the previous purchase', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { yearVisits: 7 },
    });
    await overlap(
      () => loyalty.processTicketPurchase(purchase(10)),
      () => loyalty.processTicketPurchase(purchase(10)),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 125,
        lifetimePoints: 25,
        yearPoints: 25,
        yearVisits: 9,
        tier: 'SILVER',
      }),
    );
    expect(
      (await ledger()).map((row) => row.points).sort((a, b) => a - b),
    ).toEqual([10, 15]);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('admin additions resolve tier from the combined protected year points', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { yearPoints: 1980 },
    });
    await overlap(
      () => admin.modifyPointsGrpc(userId, 'admin', 10, 'integration'),
      () => admin.modifyPointsGrpc(userId, 'admin', 10, 'integration'),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 120,
        lifetimePoints: 20,
        yearPoints: 2000,
        tier: 'SILVER',
      }),
    );
    expect(await ledger()).toHaveLength(2);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it('serializes scheduled birthday grants with purchases', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { birthdayDate: new Date(today) },
    });
    await overlap(
      () => loyalty.grantBirthdayBonuses(),
      () => loyalty.processTicketPurchase(purchase(10)),
    );
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 220,
        lifetimePoints: 120,
        yearPoints: 120,
        yearVisits: 1,
      }),
    );
    expect(
      (await ledger()).map((row) => row.points).sort((a, b) => a - b),
    ).toEqual([20, 100]);
    expect(await prisma.userBonusGrant.count()).toBe(1);
  });

  it('does not overwrite an admin GOLD grant with a stale purchase tier', async () => {
    await overlap(
      () => admin.grantVipStatusGrpc(userId, 'admin', 'integration'),
      () => loyalty.processTicketPurchase(purchase(10)),
    );
    const current = await profile();
    expect(current.tier).toBe('GOLD');
    expect([110, 120]).toContain(current.balance);
    expect(current.lifetimePoints).toBe(current.balance - 100);
    expect(await ledger()).toHaveLength(2);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it.each(['40001', '40P01'])(
    'retries PostgreSQL conflict %s once without a duplicate effect',
    async (sqlState) => {
      await observer.query('CREATE SEQUENCE conflict_attempts');
      await observer.query(`CREATE FUNCTION inject_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('conflict_attempts') = 1 THEN
          RAISE EXCEPTION 'injected transaction conflict' USING ERRCODE = '${sqlState}';
        END IF;
        RETURN NEW;
      END $$`);
      await observer.query(
        'CREATE TRIGGER inject_conflict BEFORE UPDATE ON loyalty_profiles FOR EACH ROW EXECUTE FUNCTION inject_conflict()',
      );
      try {
        await loyalty.processTicketPurchase(purchase(10));
        expect((await profile()).balance).toBe(110);
        expect(await ledger()).toHaveLength(1);
        expect(await prisma.processedEvent.count()).toBe(1);
        expect(
          (
            await observer.query<{ last_value: string }>(
              'SELECT last_value FROM conflict_attempts',
            )
          ).rows[0].last_value,
        ).toBe('2');
      } finally {
        await observer.query(
          'DROP TRIGGER inject_conflict ON loyalty_profiles',
        );
        await observer.query('DROP FUNCTION inject_conflict()');
        await observer.query('DROP SEQUENCE conflict_attempts');
      }
    },
  );

  it.each(['40001', '40P01'])(
    'bounds PostgreSQL conflict %s retries and rolls back every attempt',
    async (sqlState) => {
      await observer.query('CREATE SEQUENCE conflict_attempts');
      await observer.query(`CREATE FUNCTION inject_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM nextval('conflict_attempts');
        RAISE EXCEPTION 'injected persistent conflict' USING ERRCODE = '${sqlState}';
      END $$`);
      await observer.query(
        'CREATE TRIGGER inject_conflict BEFORE UPDATE ON loyalty_profiles FOR EACH ROW EXECUTE FUNCTION inject_conflict()',
      );
      try {
        await expect(
          loyalty.processTicketPurchase(purchase(10)),
        ).rejects.toThrow();
        expect((await profile()).balance).toBe(100);
        expect(await ledger()).toHaveLength(0);
        expect(await prisma.processedEvent.count()).toBe(0);
        expect(
          (
            await observer.query<{ last_value: string }>(
              'SELECT last_value FROM conflict_attempts',
            )
          ).rows[0].last_value,
        ).toBe('3');
      } finally {
        await observer.query(
          'DROP TRIGGER inject_conflict ON loyalty_profiles',
        );
        await observer.query('DROP FUNCTION inject_conflict()');
        await observer.query('DROP SEQUENCE conflict_attempts');
      }
    },
  );

  it('keeps the missing-profile results for deductions and refunds', async () => {
    await prisma.loyaltyProfile.delete({ where: { userId } });
    await expect(
      loyalty.deductPoints(userId, 80, randomUUID(), randomUUID()),
    ).rejects.toBeInstanceOf(RpcException);
    expect(
      await expiration.refundPoints(userId, 40, randomUUID(), randomUUID()),
    ).toEqual({
      success: false,
      balanceAfter: 0,
      errorMessage: 'Loyalty profile not found for user',
    });
    expect(await prisma.loyaltyProfile.count()).toBe(0);
    expect(await ledger()).toHaveLength(0);
  });

  it('serializes first-time profile creators through the unique user key', async () => {
    await prisma.loyaltyProfile.delete({ where: { userId } });
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'INSERT INTO loyalty_profiles (id, user_id, updated_at) VALUES ($1, $2, NOW())',
      [randomUUID(), userId],
    );
    const operations = Promise.allSettled([
      loyalty.processTicketPurchase(purchase(10)),
      loyalty.processTicketPurchase(purchase(20)),
    ]);
    try {
      await waitForBlockedWriters(2);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await operations;
    }
    const results = await operations;
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 30,
        lifetimePoints: 30,
        yearPoints: 30,
        yearVisits: 2,
      }),
    );
    expect(await ledger()).toHaveLength(2);
  });

  it('retries raw PostgreSQL deadlock SQLSTATE without committing a partial effect', async () => {
    await observer.query('CREATE SEQUENCE conflict_attempts');
    await observer.query(`CREATE FUNCTION inject_raw_conflict() RETURNS integer LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('conflict_attempts') = 1 THEN
          RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01';
        END IF;
        RETURN 1;
      END $$`);
    try {
      await withTransactionRetry(prisma, async (tx) => {
        await tx.loyaltyProfile.update({
          where: { userId },
          data: { balance: { increment: 10 } },
        });
        await tx.$queryRaw`SELECT inject_raw_conflict()`;
      });
      expect((await profile()).balance).toBe(110);
      expect(
        (
          await observer.query<{ last_value: string }>(
            'SELECT last_value FROM conflict_attempts',
          )
        ).rows[0].last_value,
      ).toBe('2');
    } finally {
      await observer.query('DROP FUNCTION inject_raw_conflict()');
      await observer.query('DROP SEQUENCE conflict_attempts');
    }
  });

  it('rechecks birthday eligibility under lock after the scheduler selected candidates', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const changedBirthday = today.endsWith('01-01')
      ? '2000-02-01'
      : '2000-01-01';
    const blockerUserId = randomUUID();
    await prisma.loyaltyProfile.create({
      data: {
        id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        userId: blockerUserId,
        birthdayDate: new Date(today),
      },
    });
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { birthdayDate: new Date(today) },
    });
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM loyalty_profiles WHERE user_id = $1 FOR UPDATE',
      [blockerUserId],
    );
    const granting = loyalty.grantBirthdayBonuses();
    const completion = Promise.allSettled([granting]);
    try {
      await waitForBlockedWriters(1);
      await loyalty.processUserDateOfBirthSet({
        userId,
        dateOfBirth: changedBirthday,
      });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await completion;
    }
    await granting;
    expect(await profile()).toEqual(
      expect.objectContaining({
        balance: 100,
        lifetimePoints: 0,
        yearPoints: 0,
        birthdayDate: new Date(changedBirthday),
      }),
    );
    expect(await ledger()).toHaveLength(0);
    expect(await prisma.userBonusGrant.count({ where: { userId } })).toBe(0);
  });
});
