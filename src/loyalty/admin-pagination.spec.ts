import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminLoyaltyService } from './admin-loyalty.service';
import { LoyaltyCalculatorService } from './loyalty-calculator.service';
import { PrismaService } from 'src/prisma/prisma.service';

const profiles = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const history = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const count = jest.fn<(...args: unknown[]) => Promise<number>>();

describe('Admin pagination bounds', () => {
  let service: AdminLoyaltyService;
  let module: TestingModule;
  beforeEach(async () => {
    jest.clearAllMocks();
    profiles.mockResolvedValue([]);
    history.mockResolvedValue([]);
    count.mockResolvedValue(7);
    module = await Test.createTestingModule({
      providers: [
        AdminLoyaltyService,
        LoyaltyCalculatorService,
        {
          provide: PrismaService,
          useValue: {
            loyaltyProfile: { findMany: profiles, count },
            pointsTransaction: { findMany: history },
          },
        },
      ],
    }).compile();
    service = module.get(AdminLoyaltyService);
  });
  afterEach(async () => {
    await module.close();
  });
  it.each([undefined, 0, 1, 100])(
    'bounds user list for limit %s while preserving filters and total',
    async (limit) => {
      expect(
        await service.getUsersGrpc(limit, 2, 'SILVER', ['user-1']),
      ).toEqual({ profiles: [], totalCount: 7 });
      expect(profiles).toHaveBeenCalledWith({
        where: { tier: 'SILVER', userId: { in: ['user-1'] } },
        orderBy: { lifetimePoints: 'desc' },
        take: limit || 50,
        skip: 2,
      });
      expect(count).toHaveBeenCalledWith({
        where: { tier: 'SILVER', userId: { in: ['user-1'] } },
      });
    },
  );
  it.each([undefined, 0, 1, 100])(
    'bounds history for limit %s',
    async (limit) => {
      await service.getTransactionHistoryGrpc('user-1', limit, 2);
      expect(history).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
        take: limit || 50,
        skip: 2,
      });
    },
  );
  it('defaults omitted list arguments', async () => {
    await service.getUsersGrpc(undefined, undefined);
    expect(profiles).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50, skip: 0 }),
    );
  });
  it.each([
    [-1, 0],
    [101, 0],
    [1.5, 0],
    [1, -1],
    [1, 0.5],
    [NaN, 0],
    [Infinity, 0],
  ])(
    'rejects invalid limit/skip %s/%s before querying',
    async (limit, skip) => {
      await expect(service.getUsersGrpc(limit, skip)).rejects.toMatchObject({
        error: { code: 3 },
      });
      await expect(
        service.getTransactionHistoryGrpc('user-1', limit, skip),
      ).rejects.toMatchObject({ error: { code: 3 } });
      expect(profiles).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    },
  );
});
