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
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClientGrpcProxy,
  RpcException,
  Transport,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { Metadata, status } from '@grpc/grpc-js';
import { lastValueFrom, Observable, timeout } from 'rxjs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { LoyaltyController } from './loyalty/loyalty.controller';
import { LoyaltyService } from './loyalty/loyalty.service';
import { LoyaltyExpirationService } from './loyalty/loyalty-expiration.service';
import { AdminLoyaltyService } from './loyalty/admin-loyalty.service';
import { AchievementsController } from './achievements/achievements.controller';
import { AchievementsService } from './achievements/achievements.service';
import { AdminAchievementsService } from './achievements/admin-achievements.service';
import { GrpcApiKeyGuard } from './guards/grpc-api-key.guard';
import { configureHttp } from './config/configure-http';

type Unary = (
  data: Record<string, unknown>,
  metadata: Metadata,
) => Observable<unknown>;
interface LoyaltyRpc {
  getBalance: Unary;
  getFullProfile: Unary;
  getTransactions: Unary;
  calculateDiscount: Unary;
  getAdminUserBalance: Unary;
  getAdminTransactionHistory: Unary;
  getAdminUsers: Unary;
  modifyUserPoints: Unary;
  grantVipStatus: Unary;
  useGoldUpgrade: Unary;
  rollbackGoldUpgrade: Unary;
}
interface AchievementRpc {
  getUserAchievements: Unary;
  updateAchievement: Unary;
  deleteAchievement: Unary;
}
const userId = '11111111-1111-4111-8111-111111111111';
const metadata = new Metadata();
metadata.set('x-api-key', 'transport-fixture-key');
const balance = { balance: 100, lifetimePoints: 100, yearPoints: 100, tier: 1 };
const getBalance = jest.fn<(userId: string) => Promise<typeof balance>>();
const calculateDiscount = jest.fn<
  (
    userId: string,
    amount: number,
  ) => Promise<{
    isAllowed: boolean;
    pointsToDeduct: number;
    amountToPay: number;
  }>
>();
const read =
  jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string')
    throw new Error('No loopback port');
  return address.port;
}
function call(method: Unary, data: Record<string, unknown>, auth = metadata) {
  return lastValueFrom(method(data, auth).pipe(timeout(5000)));
}

describe('Hybrid application gRPC boundaries on a real loopback transport', () => {
  let app: INestApplication;
  let client: ClientGrpcProxy;
  let rpc: LoyaltyRpc;
  let achievements: AchievementRpc;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [LoyaltyController, AchievementsController],
      providers: [
        GrpcApiKeyGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            INTERNAL_API_KEY: 'transport-fixture-key',
          }),
        },
        {
          provide: LoyaltyService,
          useValue: {
            getBalance,
            getFullProfile: read,
            getUserTransactions: read,
            calculateDiscount,
            useGoldUpgrade: read,
            rollbackGoldUpgrade: read,
          },
        },
        { provide: LoyaltyExpirationService, useValue: {} },
        {
          provide: AdminLoyaltyService,
          useValue: {
            getUserBalanceGrpc: read,
            getTransactionHistoryGrpc: read,
            getUsersGrpc: read,
            modifyPointsGrpc: read,
            grantVipStatusGrpc: read,
          },
        },
        {
          provide: AchievementsService,
          useValue: { getUserAchievementsGrpc: read },
        },
        {
          provide: AdminAchievementsService,
          useValue: {
            updateAchievementGrpc: read,
            deleteAchievementGrpc: read,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    configureHttp(app, 'https://cinema.example.invalid');
    const url = `127.0.0.1:${await freePort()}`;
    const options = {
      package: 'loyalty.v1',
      protoPath: resolve('src/proto/loyalty/v1/loyalty.proto'),
      url,
    };
    // Same hybrid isolation as production: HTTP global pipes are not inherited.
    app.connectMicroservice({ transport: Transport.GRPC, options });
    await app.init();
    await app.startAllMicroservices();
    client = new ClientGrpcProxy({ ...options, loader: { defaults: true } });
    rpc = client.getService<LoyaltyRpc>('LoyaltyService');
    achievements = client.getService<AchievementRpc>('AchievementsService');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    getBalance.mockResolvedValue(balance);
    read.mockResolvedValue({});
    calculateDiscount.mockImplementation((_userId, amount) =>
      Promise.resolve({
        isAllowed: false,
        pointsToDeduct: 0,
        amountToPay: amount,
      }),
    );
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  it('keeps valid UUID and fractional money values unchanged', async () => {
    await expect(call(rpc.getBalance, { userId })).resolves.toMatchObject(
      balance,
    );
    expect(getBalance).toHaveBeenCalledWith(userId);
    await expect(
      call(rpc.calculateDiscount, { userId, orderAmount: 100.25 }),
    ).resolves.toMatchObject({ amountToPay: 100.25 });
    expect(calculateDiscount).toHaveBeenCalledWith(userId, 100.25);
  });
  it('accepts PostgreSQL/.NET Guid shapes without imposing UUID version requirements', async () => {
    await expect(
      call(rpc.getBalance, { userId: '00000000-0000-0000-0000-000000000000' }),
    ).resolves.toMatchObject(balance);
  });
  it.each([
    'getBalance',
    'getFullProfile',
    'getTransactions',
    'getAdminUserBalance',
    'getAdminTransactionHistory',
    'modifyUserPoints',
    'grantVipStatus',
  ] as const)(
    '%s rejects invalid userId before calling business services',
    async (method) => {
      await expect(
        call(rpc[method], { userId: 'PRIVATE_INVALID_USER' }),
      ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
      expect(getBalance).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );
  it('rejects omitted required protobuf strings', async () => {
    await expect(call(rpc.getBalance, {})).rejects.toMatchObject({
      code: status.INVALID_ARGUMENT,
    });
    expect(getBalance).not.toHaveBeenCalled();
  });
  it.each(['useGoldUpgrade', 'rollbackGoldUpgrade'] as const)(
    '%s rejects invalid orderId before transactions',
    async (method) => {
      await expect(
        call(rpc[method], { userId, orderId: 'invalid' }),
      ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it.each([NaN, Infinity, -Infinity])(
    'rejects non-finite protobuf double %s',
    async (orderAmount) => {
      await expect(
        call(rpc.calculateDiscount, { userId, orderAmount }),
      ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
      expect(calculateDiscount).not.toHaveBeenCalled();
    },
  );
  it('preserves zero/default preview and existing finite negative-amount domain behavior', async () => {
    await expect(
      call(rpc.calculateDiscount, { userId }),
    ).resolves.toMatchObject({ amountToPay: 0 });
    await expect(
      call(rpc.calculateDiscount, { userId, orderAmount: -1 }),
    ).resolves.toMatchObject({ amountToPay: -1 });
  });
  it.each([{ tierFilter: 'INVALID' }, { userIds: ['invalid'] }])(
    'rejects invalid admin filters %j',
    async (filter) => {
      await expect(call(rpc.getAdminUsers, filter)).rejects.toMatchObject({
        code: status.INVALID_ARGUMENT,
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it('preserves empty admin filters, protobuf pagination defaults and opaque admin identifiers', async () => {
    await call(rpc.getAdminUsers, {});
    expect(read).toHaveBeenLastCalledWith(50, 0, undefined, undefined);
    await call(rpc.modifyUserPoints, {
      userId,
      adminId: 'external-admin-identity',
      points: 1,
      reason: 'fixture',
    });
    expect(read).toHaveBeenLastCalledWith(
      userId,
      'external-admin-identity',
      1,
      'fixture',
    );
  });
  it.each([
    'getUserAchievements',
    'updateAchievement',
    'deleteAchievement',
  ] as const)('%s validates database identifiers', async (method) => {
    await expect(
      call(achievements[method], { userId: 'invalid', id: 'invalid' }),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(read).not.toHaveBeenCalled();
  });
  it.each([undefined, 'wrong-key'])(
    'keeps UNAUTHENTICATED before validation for key %s',
    async (key) => {
      const auth = new Metadata();
      if (key) auth.set('x-api-key', key);
      await expect(
        call(rpc.getBalance, { userId: 'invalid' }, auth),
      ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
      expect(getBalance).not.toHaveBeenCalled();
    },
  );
  it('keeps known RPC exception codes/details unchanged', async () => {
    getBalance.mockRejectedValueOnce(
      new RpcException({
        code: status.UNAVAILABLE,
        message: 'Controlled transient failure',
      }),
    );
    await expect(call(rpc.getBalance, { userId })).rejects.toMatchObject({
      code: status.UNAVAILABLE,
      details: 'Controlled transient failure',
    });
  });
  it('reports unexpected failures as INTERNAL without sensitive transport logs or response details', async () => {
    const logs = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    getBalance.mockRejectedValueOnce(
      new Error(
        'postgresql://user:PRIVATE_PASSWORD@host/db PRIVATE_CUSTOMER_PAYLOAD',
      ),
    );
    await expect(call(rpc.getBalance, { userId })).rejects.toMatchObject({
      code: status.INTERNAL,
      details: 'Internal server error',
    });
    const captured = JSON.stringify(logs.mock.calls);
    expect(captured).toContain('INTERNAL');
    expect(captured).not.toContain('PRIVATE_PASSWORD');
    expect(captured).not.toContain('PRIVATE_CUSTOMER_PAYLOAD');
  });
});
