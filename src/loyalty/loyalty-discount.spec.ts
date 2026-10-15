import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter2 } from 'eventemitter2';
import { PrismaService } from 'src/prisma/prisma.service';
import { AchievementsService } from 'src/achievements/achievements.service';
import { LoyaltyCalculatorService } from './loyalty-calculator.service';
import { LoyaltyService } from './loyalty.service';

describe('LoyaltyService.calculateDiscount', () => {
  const findUnique = jest.fn();
  let service: LoyaltyService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        {
          provide: PrismaService,
          useValue: { loyaltyProfile: { findUnique } },
        },
        { provide: EventEmitter2, useValue: {} },
        { provide: LoyaltyCalculatorService, useValue: {} },
        { provide: AchievementsService, useValue: {} },
      ],
    }).compile();
    service = module.get(LoyaltyService);
  });

  it.each([
    [100, 100, false, 0, 100],
    [149, 100, false, 0, 149],
    [150, 100, true, 75, 75],
    [150, 0, false, 0, 150],
    [150, 74, false, 0, 150],
    [150, 75, true, 75, 75],
    [200, 100, true, 100, 100],
  ])(
    'order %i and balance %i returns allowed=%s, points=%i, due=%i',
    async (orderAmount, balance, isAllowed, pointsToDeduct, amountToPay) => {
      findUnique.mockResolvedValueOnce({ balance });

      await expect(
        service.calculateDiscount('user-1', orderAmount),
      ).resolves.toEqual({
        isAllowed,
        pointsToDeduct,
        amountToPay,
      });
    },
  );

  it('returns the original amount when the profile is missing', async () => {
    findUnique.mockResolvedValueOnce(null);

    await expect(service.calculateDiscount('missing', 150)).resolves.toEqual({
      isAllowed: false,
      pointsToDeduct: 0,
      amountToPay: 150,
    });
  });
});
