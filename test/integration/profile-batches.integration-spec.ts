import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Prisma, LoyaltyProfile } from 'src/generated/prisma/client';
import { INJECTION_TOKENS } from 'src/loyalty/constants/loyalty.constants';
import { LoyaltyExpirationService } from 'src/loyalty/loyalty-expiration.service';
import { PrismaService } from 'src/prisma/prisma.service';

// Explicit IDs place non-candidates between candidates in PostgreSQL UUID order.
function profileId(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
}

describe('Profile batch traversal on PostgreSQL', () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let expiration: LoyaltyExpirationService;
  const notifiedUsers: string[] = [];
  const past = new Date('2020-01-01T00:00:00Z');
  const future = new Date('2090-01-01T00:00:00Z');

  beforeAll(async () => {
    const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
    if (!databaseUrl) throw new Error('Run through bun run test:integration');
    const parsedUrl = new URL(databaseUrl);
    if (
      parsedUrl.hostname !== '127.0.0.1' ||
      parsedUrl.pathname !== '/loyalty_integration' ||
      parsedUrl.username !== 'loyalty_test'
    ) {
      throw new Error('Batch tests require disposable local PostgreSQL');
    }
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        LoyaltyExpirationService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ DATABASE_URL: databaseUrl }),
        },
        {
          provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT,
          useValue: {
            emit: (_event: string, payload: { userId: string }) => {
              notifiedUsers.push(payload.userId);
            },
          },
        },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    expiration = module.get(LoyaltyExpirationService);
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE loyalty_profiles, points_transactions CASCADE`;
    notifiedUsers.length = 0;
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (module) await module.close();
  });

  async function seed(
    count: number,
    candidateFields: (
      index: number,
    ) => Partial<Prisma.LoyaltyProfileCreateManyInput>,
    excludedFields: Partial<Prisma.LoyaltyProfileCreateManyInput>[],
  ): Promise<{ candidates: LoyaltyProfile[]; excluded: LoyaltyProfile[] }> {
    const candidates = Array.from({ length: count }, (_, index) => ({
      id: profileId((index + 1) * 2),
      userId: randomUUID(),
      balance: 10 + (index % 17),
      lifetimePoints: 700 + index,
      tier: 'SILVER' as const,
      tierExpiresAt: future,
      lastActivityAt: past,
      balanceExpiresAt: past,
      birthdayDate: past,
      lastExpiryNotificationAt: past,
      goldUpgradeUsedMonth: '2020-01',
      ...candidateFields(index),
    }));
    const excluded = excludedFields.map((fields, index) => ({
      ...candidates[0],
      id: profileId(index * 500 + 1),
      userId: randomUUID(),
      ...fields,
    }));
    await prisma.loyaltyProfile.createMany({
      data: [...candidates, ...excluded],
    });
    return {
      candidates: await prisma.loyaltyProfile.findMany({
        where: { userId: { in: candidates.map((profile) => profile.userId) } },
        orderBy: { id: 'desc' },
      }),
      excluded: await prisma.loyaltyProfile.findMany({
        where: { userId: { in: excluded.map((profile) => profile.userId) } },
        orderBy: { id: 'desc' },
      }),
    };
  }

  async function expectProfiles(
    before: LoyaltyProfile[],
    changes: Partial<LoyaltyProfile>,
  ): Promise<void> {
    const after = await prisma.loyaltyProfile.findMany({
      where: { userId: { in: before.map((profile) => profile.userId) } },
      orderBy: { id: 'desc' },
    });
    expect(after).toEqual(
      before.map((profile) => ({
        ...profile,
        ...changes,
        ...(Object.keys(changes).length ? { updatedAt: expect.any(Date) } : {}),
      })),
    );
  }

  it.each([500, 501, 1001])(
    'expires all %i candidates exactly once across batches',
    async (count) => {
      const { candidates, excluded } = await seed(count, () => ({}), [
        { balance: 0 },
        { balanceExpiresAt: future },
        { balanceExpiresAt: null },
      ]);
      await expiration.expirePoints();
      await expectProfiles(candidates, { balance: 0 });
      await expectProfiles(excluded, {});

      const ledger = await prisma.pointsTransaction.findMany();
      expect(ledger).toHaveLength(count);
      const entriesByUser = new Map(
        ledger.map((entry) => [entry.userId, entry]),
      );
      expect(entriesByUser.size).toBe(count);
      for (const profile of candidates) {
        expect(entriesByUser.get(profile.userId)).toMatchObject({
          type: 'EXPIRE',
          points: -profile.balance,
          balanceAfter: 0,
        });
      }
      expect(ledger.reduce((sum, entry) => sum + entry.points, 0)).toBe(
        -candidates.reduce((sum, profile) => sum + profile.balance, 0),
      );
      await expiration.expirePoints();
      expect(await prisma.pointsTransaction.count()).toBe(count);
      await expectProfiles(excluded, {});
    },
  );

  it.each([500, 501, 1001])(
    'resets all %i annual counters without changing other fields',
    async (count) => {
      const { candidates, excluded } = await seed(
        count,
        (index) => ({
          yearPoints: index % 2 === 0 ? 100 + index : 0,
          yearVisits: index % 2 === 1 ? 1 + index : 0,
        }),
        [{ yearPoints: 0, yearVisits: 0 }],
      );
      await expiration.resetAnnualStats();
      await expectProfiles(candidates, { yearPoints: 0, yearVisits: 0 });
      await expectProfiles(excluded, {});
      expect(await prisma.pointsTransaction.count()).toBe(0);
    },
  );

  it('resets all 501 GOLD quotas when the previous cursor leaves the filter', async () => {
    const { candidates, excluded } = await seed(501, () => ({}), [
      { goldUpgradeUsedMonth: null },
    ]);
    await expiration.goldReset();
    await expectProfiles(candidates, { goldUpgradeUsedMonth: null });
    await expectProfiles(excluded, {});
  });

  it('notifies all 501 candidates when the previous cursor leaves the filter', async () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const { candidates, excluded } = await seed(
      501,
      () => ({ balanceExpiresAt: soon }),
      [
        { balanceExpiresAt: future },
        { balance: 0 },
        { lastExpiryNotificationAt: new Date() },
      ],
    );
    await expiration.notifyExpiringUsers();
    const compareIds = (a: string, b: string) => a.localeCompare(b);
    expect([...notifiedUsers].sort(compareIds)).toEqual(
      candidates.map((profile) => profile.userId).sort(compareIds),
    );
    await expectProfiles(excluded, {});
    await expiration.notifyExpiringUsers();
    expect(notifiedUsers).toHaveLength(501);
  });
});
