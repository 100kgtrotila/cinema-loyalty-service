import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import { INestMicroservice } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientGrpcProxy, Transport } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { Metadata, status } from '@grpc/grpc-js';
import { EventEmitter2 } from 'eventemitter2';
import { lastValueFrom, Observable } from 'rxjs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaService } from 'src/prisma/prisma.service';
import { LoyaltyController } from 'src/loyalty/loyalty.controller';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { LoyaltyExpirationService } from 'src/loyalty/loyalty-expiration.service';
import { AdminLoyaltyService } from 'src/loyalty/admin-loyalty.service';
import { LoyaltyCalculatorService } from 'src/loyalty/loyalty-calculator.service';
import { GrpcApiKeyGuard } from 'src/guards/grpc-api-key.guard';
import { AchievementsService } from 'src/achievements/achievements.service';
import { INJECTION_TOKENS } from 'src/loyalty/constants/loyalty.constants';

type Result = { success: boolean; balanceAfter: number; errorMessage: string };
interface Rpc {
  getBalance(
    data: { userId?: string },
    metadata: Metadata,
  ): Observable<{ balance: number }>;
  calculateDiscount(
    data: { userId: string; orderAmount?: number },
    metadata: Metadata,
  ): Observable<{ isAllowed: boolean; amountToPay: number }>;
  useGoldUpgrade(
    data: { userId: string; orderId: string },
    metadata: Metadata,
  ): Observable<Result>;
  deductPoints(
    data: {
      userId: string;
      orderId: string;
      amount: number;
      idempotencyKey: string;
    },
    metadata: Metadata,
  ): Observable<Result>;
  refundPoints(
    data: {
      userId: string;
      orderId: string;
      amount: number;
      idempotencyKey: string;
    },
    metadata: Metadata,
  ): Observable<Result>;
}

describe('gRPC boundaries with real PostgreSQL', () => {
  let prisma: PrismaService;
  let server: INestMicroservice;
  let client: ClientGrpcProxy;
  let rpc: Rpc;
  const auth = new Metadata();
  auth.set('x-api-key', 'integration-key');
  beforeAll(async () => {
    const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
    if (!databaseUrl) throw new Error('Run bun run test:integration');
    const database = new URL(databaseUrl);
    if (
      database.hostname !== '127.0.0.1' ||
      database.pathname !== '/loyalty_integration'
    )
      throw new Error('Disposable integration database required');
    const module = await Test.createTestingModule({
      controllers: [LoyaltyController],
      providers: [
        PrismaService,
        LoyaltyService,
        LoyaltyExpirationService,
        LoyaltyCalculatorService,
        GrpcApiKeyGuard,
        AdminLoyaltyService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            DATABASE_URL: databaseUrl,
            INTERNAL_API_KEY: 'integration-key',
          }),
        },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: AchievementsService, useValue: {} },
        { provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT, useValue: {} },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    const probe = createServer();
    await new Promise<void>((yes, no) => {
      probe.once('error', no);
      probe.listen(0, '127.0.0.1', yes);
    });
    const address = probe.address();
    await new Promise<void>((yes, no) =>
      probe.close((error) => (error ? no(error) : yes())),
    );
    if (!address || typeof address === 'string')
      throw new Error('No loopback port');
    const options = {
      url: `127.0.0.1:${address.port}`,
      package: 'loyalty.v1',
      protoPath: resolve('src/proto/loyalty/v1/loyalty.proto'),
    };
    server = module.createNestMicroservice(
      { transport: Transport.GRPC, options },
      { logger: false },
    );
    await server.listen();
    client = new ClientGrpcProxy({ ...options, loader: { defaults: true } });
    rpc = client.getService<Rpc>('LoyaltyService');
  });
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE loyalty_profiles, points_transactions, processed_events, gold_upgrade_reservations CASCADE`;
  });
  afterAll(async () => {
    client?.close();
    await server?.close();
    await prisma?.$disconnect();
  });

  it('rejects malformed/missing UUID without creating any profile', async () => {
    for (const request of [{}, { userId: 'PRIVATE_INVALID_UUID' }])
      await expect(
        lastValueFrom(rpc.getBalance(request, auth)),
      ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await prisma.loyaltyProfile.count()).toBe(0);
    expect(await prisma.pointsTransaction.count()).toBe(0);
  });
  it('rejects malformed GOLD orderId before reservation writes', async () => {
    const userId = randomUUID();
    await prisma.loyaltyProfile.create({
      data: { userId, balance: 100, tier: 'GOLD' },
    });
    await expect(
      lastValueFrom(rpc.useGoldUpgrade({ userId, orderId: 'invalid' }, auth)),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await prisma.goldUpgradeReservation.count()).toBe(0);
    expect(
      await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
    ).toMatchObject({ balance: 100, goldUpgradeUsedMonth: null });
  });
  it('rejects non-finite doubles while preserving finite fractional money and protobuf zero default', async () => {
    const userId = randomUUID();
    await prisma.loyaltyProfile.create({ data: { userId, balance: 500 } });
    for (const orderAmount of [NaN, Infinity, -Infinity])
      await expect(
        lastValueFrom(rpc.calculateDiscount({ userId, orderAmount }, auth)),
      ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(
      lastValueFrom(rpc.calculateDiscount({ userId }, auth)),
    ).resolves.toMatchObject({ isAllowed: false, amountToPay: 0 });
    await expect(
      lastValueFrom(
        rpc.calculateDiscount({ userId, orderAmount: 200.5 }, auth),
      ),
    ).resolves.toMatchObject({ isAllowed: true, amountToPay: 100.5 });
    expect(
      await prisma.loyaltyProfile.findUniqueOrThrow({ where: { userId } }),
    ).toMatchObject({ balance: 500 });
    expect(await prisma.pointsTransaction.count()).toBe(0);
  });
  it('keeps authentication ahead of payload validation and permits a valid authenticated request', async () => {
    for (const key of [undefined, 'incorrect']) {
      const metadata = new Metadata();
      if (key) metadata.set('x-api-key', key);
      await expect(
        lastValueFrom(rpc.getBalance({ userId: 'invalid' }, metadata)),
      ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
    }
    expect(await prisma.loyaltyProfile.count()).toBe(0);
    await expect(
      lastValueFrom(rpc.getBalance({ userId: randomUUID() }, auth)),
    ).resolves.toMatchObject({ balance: 0 });
  });
  it('preserves the existing invalid point-command business response and successful debit/refund replay', async () => {
    const userId = randomUUID();
    await prisma.loyaltyProfile.create({ data: { userId, balance: 100 } });
    const command = {
      userId,
      orderId: randomUUID(),
      amount: 80,
      idempotencyKey: randomUUID(),
    };
    for (const method of ['deductPoints', 'refundPoints'] as const)
      await expect(
        lastValueFrom(rpc[method]({ ...command, amount: -1 }, auth)),
      ).resolves.toMatchObject({ success: false });
    await expect(
      lastValueFrom(rpc.deductPoints(command, auth)),
    ).resolves.toMatchObject({ success: true, balanceAfter: 20 });
    const refund = { ...command, idempotencyKey: randomUUID() };
    for (let retry = 0; retry < 2; retry++)
      await expect(
        lastValueFrom(rpc.refundPoints(refund, auth)),
      ).resolves.toMatchObject({ success: true, balanceAfter: 100 });
    expect(await prisma.pointsTransaction.count()).toBe(2);
  });
  it('returns safe INTERNAL on a real database exception without partial writes', async () => {
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION grpc_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_DATABASE_FAILURE'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER grpc_fixture_failure BEFORE INSERT ON loyalty_profiles FOR EACH ROW EXECUTE FUNCTION grpc_fixture_failure()`,
    );
    try {
      await expect(
        lastValueFrom(rpc.getBalance({ userId: randomUUID() }, auth)),
      ).rejects.toMatchObject({
        code: status.INTERNAL,
        details: 'Internal server error',
      });
      expect(await prisma.loyaltyProfile.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER grpc_fixture_failure ON loyalty_profiles',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION grpc_fixture_failure()');
    }
  });
});
