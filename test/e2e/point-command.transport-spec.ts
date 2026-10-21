import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import type { INestMicroservice, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientGrpcProxy, Transport } from '@nestjs/microservices';
import { Test, TestingModule } from '@nestjs/testing';
import { Metadata, status } from '@grpc/grpc-js';
import type { ClientUnaryCall, ServiceError } from '@grpc/grpc-js';
import { Observable, NEVER, lastValueFrom, mergeMap, of } from 'rxjs';
import { EventEmitter2 } from 'eventemitter2';
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
import type { DeductPointsRequest } from 'src/loyalty/interfaces/loyalty-request.interface';

interface PointResult {
  success: boolean;
  balanceAfter: number;
  errorMessage: string;
}
interface PointRpc {
  getAdminUsers(
    request: {
      limit?: number;
      skip?: number;
      tierFilter?: string;
      userIds?: string[];
    },
    metadata: Metadata,
  ): Observable<{ profiles: { userId: string }[]; totalCount: number }>;
  getAdminTransactionHistory(
    request: { userId: string; limit?: number; skip?: number },
    metadata: Metadata,
  ): Observable<{ transactions: { id: string }[] }>;

  useGoldUpgrade(
    request: { userId: string; orderId: string },
    metadata: Metadata,
  ): Observable<{ success: boolean; errorMessage: string }>;
  rollbackGoldUpgrade(
    request: { userId: string; orderId: string },
    metadata: Metadata,
  ): Observable<{ success: boolean; errorMessage: string }>;
  deductPoints(
    request: DeductPointsRequest,
    metadata: Metadata,
  ): Observable<PointResult>;
  refundPoints(
    request: DeductPointsRequest,
    metadata: Metadata,
  ): Observable<PointResult>;
}
interface PointNativeClient {
  deductPoints(
    request: DeductPointsRequest,
    metadata: Metadata,
    callback: (error: ServiceError | null, response?: PointResult) => void,
  ): ClientUnaryCall;
  refundPoints(
    request: DeductPointsRequest,
    metadata: Metadata,
    callback: (error: ServiceError | null, response?: PointResult) => void,
  ): ClientUnaryCall;
}

async function availablePort(): Promise<number> {
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
  return address.port;
}

describe('gRPC point commands after a lost committed response', () => {
  let module: TestingModule;
  let server: INestMicroservice;
  let prisma: PrismaService;
  let client: ClientGrpcProxy;
  let rpc: PointRpc;
  let url: string;
  let request: DeductPointsRequest;
  let loseNextReply = false;
  let committed: (() => void) | undefined;
  const protoPath = resolve('src/proto/loyalty/v1/loyalty.proto');
  const metadata = new Metadata();
  metadata.set('x-api-key', 'point-transport-test-key');

  function connectClient(): void {
    client = new ClientGrpcProxy({
      url,
      package: 'loyalty.v1',
      protoPath,
      loader: { defaults: true },
    });
    rpc = client.getService<PointRpc>('LoyaltyService');
  }
  beforeAll(async () => {
    const databaseUrl = process.env.E2E_OUTBOX_DATABASE_URL;
    if (!databaseUrl) throw new Error('Run bun run test:transports');
    const db = new URL(databaseUrl);
    if (
      db.hostname !== '127.0.0.1' ||
      db.pathname !== '/loyalty_outbox_transport'
    )
      throw new Error('Disposable transport database required');
    module = await Test.createTestingModule({
      controllers: [LoyaltyController],
      providers: [
        PrismaService,
        LoyaltyService,
        LoyaltyExpirationService,
        LoyaltyCalculatorService,
        GrpcApiKeyGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            DATABASE_URL: databaseUrl,
            INTERNAL_API_KEY: 'point-transport-test-key',
          }),
        },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: AchievementsService, useValue: {} },
        AdminLoyaltyService,
        { provide: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT, useValue: {} },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    url = `127.0.0.1:${await availablePort()}`;
    server = module.createNestMicroservice({
      transport: Transport.GRPC,
      options: { url, package: 'loyalty.v1', protoPath },
    });
    const lostReply: NestInterceptor = {
      intercept: (_context, next) =>
        next.handle().pipe(
          mergeMap((response: unknown) => {
            if (!loseNextReply) return of(response);
            loseNextReply = false;
            committed?.();
            return NEVER;
          }),
        ),
    };
    server.useGlobalInterceptors(lostReply);
    await server.listen();
    connectClient();
  });
  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE loyalty_profiles, points_transactions, processed_events CASCADE`;
    request = {
      userId: randomUUID(),
      orderId: randomUUID(),
      amount: 80,
      idempotencyKey: randomUUID(),
    };
    await prisma.loyaltyProfile.create({
      data: { userId: request.userId, balance: 500 },
    });
  });
  afterAll(async () => {
    if (client) client.close();
    if (server) await server.close();
    if (prisma) await prisma.$disconnect();
  });

  it('enforces admin pagination across actual protobuf defaults and RPC errors', async () => {
    const users = Array.from({ length: 101 }, () => ({
      userId: randomUUID(),
      tier: 'SILVER' as const,
    }));
    await prisma.loyaltyProfile.createMany({ data: users });
    const ids = users.map((user) => user.userId);
    expect(
      (
        await lastValueFrom(
          rpc.getAdminUsers({ userIds: ids, tierFilter: 'SILVER' }, metadata),
        )
      ).profiles,
    ).toHaveLength(50);
    const capped = await lastValueFrom(
      rpc.getAdminUsers(
        { userIds: ids, limit: 100, skip: 1, tierFilter: 'SILVER' },
        metadata,
      ),
    );
    expect(capped.profiles).toHaveLength(100);
    expect(capped.totalCount).toBe(101);
    for (const query of [{ limit: 101 }, { limit: -1 }, { skip: -1 }]) {
      await expect(
        lastValueFrom(rpc.getAdminUsers(query, metadata)),
      ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
      await expect(
        lastValueFrom(
          rpc.getAdminTransactionHistory(
            { userId: request.userId, ...query },
            metadata,
          ),
        ),
      ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    }
    await prisma.pointsTransaction.createMany({
      data: Array.from({ length: 101 }, () => ({
        userId: request.userId,
        type: 'EARN_TICKET' as const,
        points: 1,
        balanceAfter: 1,
      })),
    });
    expect(
      (
        await lastValueFrom(
          rpc.getAdminTransactionHistory({ userId: request.userId }, metadata),
        )
      ).transactions,
    ).toHaveLength(50);
    expect(
      (
        await lastValueFrom(
          rpc.getAdminTransactionHistory(
            { userId: request.userId, limit: 100, skip: 1 },
            metadata,
          ),
        )
      ).transactions,
    ).toHaveLength(100);
  });

  it.each(['deductPoints', 'refundPoints'] as const)(
    'replays %s through a new channel after commit and cancellation',
    async (method) => {
      if (method === 'refundPoints') {
        expect(
          (
            await lastValueFrom(
              rpc.deductPoints(
                { ...request, idempotencyKey: randomUUID() },
                metadata,
              ),
            )
          ).success,
        ).toBe(true);
      }
      const commit = new Promise<void>((yes) => {
        committed = yes;
      });
      loseNextReply = true;
      const native =
        client.getClientByServiceName<PointNativeClient>('LoyaltyService');
      let call: ClientUnaryCall | undefined;
      const first = Promise.allSettled([
        new Promise<PointResult>((yes, no) => {
          call = native[method](request, metadata, (error, response) => {
            if (error) no(error);
            else if (response) yes(response);
            else no(new Error('No gRPC response'));
          });
        }),
      ]);
      await Promise.race([
        commit,
        first.then(([result]) => {
          if (result.status === 'rejected') throw result.reason;
          throw new Error('Reply was delivered before the post-commit barrier');
        }),
      ]);
      expect(
        await prisma.processedEvent.count({
          where: { eventId: request.idempotencyKey },
        }),
      ).toBe(1);
      if (!call) throw new Error('gRPC call was not started');
      call.cancel(); // Cancel the actual call after commit, before its response.
      const [lost] = await first;
      expect(lost.status).toBe('rejected');
      if (lost.status === 'rejected')
        expect(lost.reason).toMatchObject({ code: status.CANCELLED });
      client.close();
      connectClient();
      const other = method === 'deductPoints' ? 'refundPoints' : 'deductPoints';
      expect(
        (
          await lastValueFrom(
            rpc[other](
              {
                ...request,
                orderId:
                  method === 'deductPoints' ? request.orderId : randomUUID(),
                idempotencyKey: randomUUID(),
              },
              metadata,
            ),
          )
        ).success,
      ).toBe(true);
      expect(await lastValueFrom(rpc[method](request, metadata))).toEqual({
        success: true,
        balanceAfter: method === 'deductPoints' ? 420 : 500,
        errorMessage: '',
      });
      const conflict = await lastValueFrom(
        rpc[method]({ ...request, amount: 100 }, metadata),
      );
      expect(conflict.success).toBe(false);
      expect(conflict.errorMessage).toContain('Idempotency');
      if (method === 'refundPoints') {
        const duplicate = await lastValueFrom(
          rpc.refundPoints(
            { ...request, idempotencyKey: randomUUID() },
            metadata,
          ),
        );
        expect(duplicate.success).toBe(false);
        expect(duplicate.errorMessage).toContain('already been compensated');
      }
      expect(
        (
          await prisma.loyaltyProfile.findUniqueOrThrow({
            where: { userId: request.userId },
          })
        ).balance,
      ).toBe(method === 'deductPoints' ? 500 : 420);
      expect(await prisma.pointsTransaction.count()).toBe(
        method === 'deductPoints' ? 2 : 3,
      );
    },
  );
  it('preserves GOLD ownership across gRPC reconnect, wrong rollback and tier change', async () => {
    const userId = request.userId;
    const orderA = randomUUID();
    const orderB = randomUUID();
    const use = (orderId: string) =>
      lastValueFrom(rpc.useGoldUpgrade({ userId, orderId }, metadata));
    const rollback = (orderId: string) =>
      lastValueFrom(rpc.rollbackGoldUpgrade({ userId, orderId }, metadata));
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { tier: 'GOLD' },
    });
    expect((await use(orderA)).success).toBe(true);
    client.close();
    connectClient();
    expect((await use(orderA)).success).toBe(true);
    expect((await rollback(orderB)).success).toBe(false);
    expect((await use(orderB)).success).toBe(false);
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { tier: 'BRONZE' },
    });
    expect((await rollback(orderA)).success).toBe(true);
    await prisma.loyaltyProfile.update({
      where: { userId },
      data: { tier: 'GOLD' },
    });
    expect((await use(orderB)).success).toBe(true);
    expect((await rollback(orderA)).success).toBe(true);
    expect((await use(orderA)).success).toBe(false);
    expect((await use(randomUUID())).success).toBe(false);
  });
});
