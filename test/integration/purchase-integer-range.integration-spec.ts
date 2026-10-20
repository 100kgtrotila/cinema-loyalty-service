import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from 'eventemitter2';
import { randomUUID } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { LoyaltyCalculatorService } from 'src/loyalty/loyalty-calculator.service';
import { AchievementsService } from 'src/achievements/achievements.service';
import { AchievementMapper } from 'src/achievements/mappers/achievement.mapper';
import { ACHIEVEMENTS_QUEUE } from 'src/achievements/constants/achievements.constants';
import { TicketPurchasedDto } from 'src/loyalty/dto/ticked-purchased.dto';
import { EventType } from 'src/loyalty/enums/event-type.enum';

const MAX_INT = 2147483647;

describe('Purchase integer boundaries on PostgreSQL', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let loyalty: LoyaltyService;
  let userId: string;

  beforeAll(async () => {
    const url = new URL(process.env.INTEGRATION_DATABASE_URL ?? '');
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/loyalty_integration')
      throw new Error('Use the disposable integration runner');
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        LoyaltyService,
        LoyaltyCalculatorService,
        AchievementsService,
        AchievementMapper,
        {
          provide: ConfigService,
          useValue: new ConfigService({ DATABASE_URL: url.toString() }),
        },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        {
          provide: getQueueToken(ACHIEVEMENTS_QUEUE),
          useValue: {
            add: () => {
              throw new Error('Purchase must not contact Redis');
            },
          },
        },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    loyalty = module.get(LoyaltyService);
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE loyalty_profiles, points_transactions, processed_events, outbox_events, achievement_dispatch_intents CASCADE`;
    userId = randomUUID();
    await prisma.loyaltyProfile.create({ data: { userId } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await module?.close();
  });

  function event(amount: number): TicketPurchasedDto {
    return {
      userId,
      eventId: randomUUID(),
      orderId: randomUUID(),
      totalAmount: amount,
      paidAmount: amount,
      ticketAmount: amount,
      foodAmount: 0,
      eventType: EventType.STANDARD,
      purchasedAt: new Date().toISOString(),
      pointsUsed: 0,
    };
  }

  async function rejectsWithoutEffects(purchase: TicketPurchasedDto) {
    const before = await prisma.loyaltyProfile.findUniqueOrThrow({
      where: { userId },
    });
    await expect(loyalty.processTicketPurchase(purchase)).rejects.toMatchObject(
      { code: 'ACCOUNTING_RANGE_EXCEEDED' },
    );
    expect(
      await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
    ).toEqual(before);
    expect(await prisma.pointsTransaction.count()).toBe(0);
    expect(await prisma.processedEvent.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.achievementDispatchIntent.count()).toBe(0);
  }

  it('rejects an unrepresentable reward before persistence', async () => {
    await rejectsWithoutEffects(event(MAX_INT + 1));
  });

  it.each(['balance', 'lifetimePoints', 'yearPoints', 'yearVisits'] as const)(
    'rejects overflow of the protected %s total atomically',
    async (field) => {
      await prisma.loyaltyProfile.update({
        where: { userId },
        data: { [field]: MAX_INT },
      });
      await rejectsWithoutEffects(event(1));
    },
  );

  it('rejects yearVisits overflow even when pointsUsed suppresses reward', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { yearVisits: MAX_INT },
    });
    await rejectsWithoutEffects({ ...event(10), pointsUsed: 1 });
  });

  it('includes the current GOLD multiplier in the range check', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { tier: 'GOLD' },
    });
    await rejectsWithoutEffects(event(1073741824));
  });

  it('includes the special-event multiplier in the range check', async () => {
    await rejectsWithoutEffects({
      ...event(1073741824),
      eventType: EventType.SPECIAL,
    });
  });

  it('includes the birthday multiplier in the range check', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { tier: 'GOLD', birthdayDate: new Date() },
    });
    await rejectsWithoutEffects(event(214748365));
  });

  it('accepts the exact maximum reward and commits ledger and intent', async () => {
    await loyalty.processTicketPurchase(event(MAX_INT));
    expect(
      await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
    ).toMatchObject({
      balance: MAX_INT,
      lifetimePoints: MAX_INT,
      yearPoints: MAX_INT,
      yearVisits: 1,
    });
    expect(await prisma.pointsTransaction.findFirstOrThrow()).toMatchObject({
      points: MAX_INT,
      balanceAfter: MAX_INT,
    });
    expect(await prisma.processedEvent.count()).toBe(1);
    expect(await prisma.achievementDispatchIntent.count()).toBe(1);
  });

  it('accepts all totals exactly at the integer boundary', async () => {
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: {
        balance: MAX_INT - 1,
        lifetimePoints: MAX_INT - 1,
        yearPoints: MAX_INT - 1,
        yearVisits: MAX_INT - 1,
      },
    });
    await loyalty.processTicketPurchase(event(1));
    expect(
      await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
    ).toMatchObject({
      balance: MAX_INT,
      lifetimePoints: MAX_INT,
      yearPoints: MAX_INT,
      yearVisits: MAX_INT,
    });
  });

  it('preserves fractional money and applies the existing reward rounding', async () => {
    await loyalty.processTicketPurchase(event(25.75));
    expect(await prisma.pointsTransaction.findFirstOrThrow()).toMatchObject({
      points: 25,
    });
  });

  it('does not impose a purchase-price cap when pointsUsed suppresses accrual', async () => {
    await loyalty.processTicketPurchase({
      ...event(MAX_INT + 1),
      pointsUsed: 1,
    });
    expect(
      await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
    ).toMatchObject({ balance: 0, yearVisits: 1 });
    expect(await prisma.pointsTransaction.count()).toBe(0);
    expect(await prisma.processedEvent.count()).toBe(1);
  });

  it('checks existing purchase dedupe before recalculating current totals', async () => {
    const purchase = event(10);
    await loyalty.processTicketPurchase(purchase);
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { yearVisits: MAX_INT },
    });
    await loyalty.processTicketPurchase(purchase);
    expect(await prisma.pointsTransaction.count()).toBe(1);
    expect(await prisma.processedEvent.count()).toBe(1);
  });
});
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
