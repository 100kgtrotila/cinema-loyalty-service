import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
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

describe('GOLD order reservations on PostgreSQL', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let loyalty: LoyaltyService;
  let expiration: LoyaltyExpirationService;
  let observer: Pool;
  let userId: string;
  let orderA: string;
  let orderB: string;

  beforeAll(async () => {
    const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
    if (
      !databaseUrl ||
      !/^postgresql:\/\/loyalty_test:.*@127\.0\.0\.1:\d+\/loyalty_integration$/.test(
        databaseUrl,
      )
    )
      throw new Error(
        'Disposable PostgreSQL required: bun run test:integration',
      );
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        LoyaltyService,
        LoyaltyExpirationService,
        LoyaltyCalculatorService,
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
    observer = new Pool({ connectionString: databaseUrl });
    await prisma.$connect();
  });
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE loyalty_profiles CASCADE`;
    await prisma.goldUpgradeReservation.deleteMany();
    userId = randomUUID();
    orderA = randomUUID();
    orderB = randomUUID();
    await prisma.loyaltyProfile.create({ data: { userId, tier: 'GOLD' } });
    // Freeze Date only; PostgreSQL/network/lock timers keep running normally.
    jest.useFakeTimers({
      now: new Date('2026-01-15T12:00:00Z'),
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
        'hrtime',
      ],
    });
  });
  afterEach(() => jest.useRealTimers());
  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (module) await module.close();
    if (observer) await observer.end();
  });
  const use = (order: string) => loyalty.useGoldUpgrade(userId, order);
  const rollback = (order: string) =>
    loyalty.rollbackGoldUpgrade(userId, order);
  const profile = () =>
    prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } });

  it('replays Use for the same order without taking a second quota', async () => {
    expect((await use(orderA)).success).toBe(true);
    expect((await use(orderA)).success).toBe(true);
    expect((await use(orderB)).success).toBe(false);
  });
  it('does not release order A when rollback names order B', async () => {
    await use(orderA);
    expect((await rollback(orderB)).success).toBe(false);
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-01');
    expect((await use(orderB)).success).toBe(false);
  });
  it('does not release the new month/order when the old owner rolls back late', async () => {
    await use(orderA);
    jest.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    expect((await use(orderB)).success).toBe(true);
    await rollback(orderA);
    expect((await use(randomUUID())).success).toBe(false);
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-02');
  });
  it('keeps a current-month reservation during goldReset', async () => {
    await use(orderA);
    await expiration.goldReset();
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-01');
    expect((await use(orderB)).success).toBe(false);
  });
  it('releases the matching reservation even if the tier has changed', async () => {
    await use(orderA);
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { tier: 'BRONZE' },
    });
    expect((await rollback(orderA)).success).toBe(true);
    expect((await profile()).goldUpgradeUsedMonth).toBeNull();
    expect((await use(orderB)).success).toBe(false);
  });
  it.each(['same', 'different'])(
    'serializes genuinely overlapping %s-order Uses',
    async (orders) => {
      const blocker = await observer.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
        [userId],
      );
      const operations = Promise.all([
        use(orderA),
        use(orders === 'same' ? orderA : orderB),
      ]);
      try {
        let overlap = false;
        for (let attempt = 0; attempt < 500; attempt++) {
          const waiting = await observer.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%loyalty_profiles%'`,
          );
          if (waiting.rows[0].count >= 2) {
            overlap = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(overlap).toBe(true);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(
        (await operations).filter((result) => result.success),
      ).toHaveLength(orders === 'same' ? 2 : 1);
      expect((await profile()).goldUpgradeUsedMonth).toBe('2026-01');
      expect(
        await prisma.goldUpgradeReservation.count({ where: { userId } }),
      ).toBe(1);
    },
  );

  it('keeps rollback terminal and does not free the next owner in the same month', async () => {
    await use(orderA);
    expect((await rollback(orderA)).success).toBe(true);
    expect((await use(orderB)).success).toBe(true);
    expect((await rollback(orderA)).success).toBe(true);
    expect((await use(orderA)).success).toBe(false);
    expect((await use(orderB)).success).toBe(true);
    expect((await use(randomUUID())).success).toBe(false);
    jest.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    expect((await use(orderA)).success).toBe(false);
    expect((await use(randomUUID())).success).toBe(true);
  });

  it('uses UTC midnight rather than the date encoded in an offset', async () => {
    jest.setSystemTime(new Date('2026-02-01T00:30:00+02:00'));
    await use(orderA);
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-01');
    jest.setSystemTime(new Date('2026-01-31T23:59:59.999Z'));
    expect((await use(orderB)).success).toBe(false);
    jest.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    expect((await use(orderB)).success).toBe(true);
    await expiration.goldReset();
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-02');
    expect(
      (
        await prisma.goldUpgradeReservation.findMany({
          where: { userId },
          orderBy: { month: 'asc' },
        })
      ).map((row) => row.month),
    ).toEqual(['2026-01', '2026-02']);
    expect((await use(orderA)).success).toBe(true); // Historical ACTIVE replay.
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-02');
  });

  it('chooses the month after a lock wait across UTC new year', async () => {
    jest.setSystemTime(new Date('2026-12-31T23:59:59.999Z'));
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    const work = use(orderA);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        const result = await observer.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%loyalty_profiles%'`,
        );
        if (result.rows[0].count >= 1) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      jest.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await work).success).toBe(true);
    expect((await profile()).goldUpgradeUsedMonth).toBe('2027-01');
  });

  it('does not let reset overwrite Use after selecting an older marker', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { goldUpgradeUsedMonth: '2025-12' },
    });
    const blocker = await observer.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM loyalty_profiles WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    const reset = expiration.goldReset();
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        const result = await observer.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%loyalty_profiles%'`,
        );
        if (result.rows[0].count >= 1) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // Simulate the preceding writer's committed protected state after selection.
      await blocker.query(
        'INSERT INTO gold_upgrade_reservations(id,user_id,month,order_id) VALUES ($1,$2,$3,$4)',
        [randomUUID(), userId, '2026-01', orderA],
      );
      await blocker.query(
        'UPDATE loyalty_profiles SET gold_upgrade_used_month=$1 WHERE user_id=$2',
        ['2026-01', userId],
      );
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await reset;
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-01');
    expect((await use(orderB)).success).toBe(false);
  });

  it('holds legacy occupancy without guessing an owner and permits a later month', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { goldUpgradeUsedMonth: '2026-01' },
    });
    await prisma.goldUpgradeReservation.create({
      data: { userId, month: '2026-01' },
    });
    expect((await use(orderA)).errorMessage).toContain('reconciliation');
    expect((await rollback(orderA)).success).toBe(false);
    await expiration.goldReset();
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-01');
    const legacy = await prisma.goldUpgradeReservation.findFirstOrThrow({
      where: { userId },
    });
    expect(legacy.orderId).toBeNull();
    expect(legacy.releasedAt).toBeNull();
    jest.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    expect((await use(orderB)).success).toBe(true);
    expect((await rollback(orderA)).success).toBe(false);
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-02');
  });

  it('does not release another user reservation or reopen a released order', async () => {
    await use(orderA);
    const otherUser = randomUUID();
    await prisma.loyaltyProfile.create({
      data: { userId: otherUser, tier: 'GOLD' },
    });
    expect((await loyalty.rollbackGoldUpgrade(otherUser, orderA)).success).toBe(
      false,
    );
    expect((await profile()).goldUpgradeUsedMonth).toBe('2026-01');
    await rollback(orderA);
    expect((await use(orderA)).success).toBe(false);
  });

  it('replays ACTIVE Use after tier change but refuses a fresh reservation', async () => {
    await use(orderA);
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { tier: 'SILVER' },
    });
    expect((await use(orderA)).success).toBe(true);
    expect((await use(orderB)).success).toBe(false);
  });

  it.each(['use', 'rollback'])(
    'rolls back reservation and mirror on %s failure',
    async (operation) => {
      if (operation === 'rollback') await use(orderA);
      const before = await profile();
      const reservations = await prisma.goldUpgradeReservation.findMany({
        where: { userId },
      });
      await observer.query(
        `CREATE FUNCTION reject_gold_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected GOLD mirror failure'; END $$`,
      );
      await observer.query(
        'CREATE TRIGGER reject_gold_mirror AFTER UPDATE ON loyalty_profiles FOR EACH ROW EXECUTE FUNCTION reject_gold_mirror()',
      );
      try {
        if (operation === 'use') await expect(use(orderA)).rejects.toThrow();
        else expect((await rollback(orderA)).success).toBe(false);
        expect(await profile()).toEqual(before);
        expect(
          await prisma.goldUpgradeReservation.findMany({ where: { userId } }),
        ).toEqual(reservations);
      } finally {
        await observer.query(
          'DROP TRIGGER reject_gold_mirror ON loyalty_profiles',
        );
        await observer.query('DROP FUNCTION reject_gold_mirror()');
      }
      expect(
        (await (operation === 'use' ? use(orderA) : rollback(orderA))).success,
      ).toBe(true);
    },
  );
});
