import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Tier } from 'src/generated/prisma/enums';
import { TicketPurchasedDto } from './dto/ticked-purchased.dto';
import EventEmitter2 from 'eventemitter2';
import { LOYALTY_RULES } from './constants/loyalty.constants';
import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';
import {
  DeductPointsResponse,
  GetBalanceResponse,
  GetFullProfileResponse,
  UseGoldUpgradeResponse,
} from './interfaces/loyalty-response.interface';
import { LoyaltyProfileSnapshot } from './interfaces/loyalty-profile.inteface';
import { LoyaltyMapper } from 'src/utils/loyalty.mapper';
import { LoyaltyCalculatorService } from './loyalty-calculator.service';
import { PointsTransactionType } from './constants/points-transaction-type.enum';

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
    private readonly calculator: LoyaltyCalculatorService,
  ) {}

  async getBalance(userId: string): Promise<GetBalanceResponse> {
    const profile = await this.prisma.loyaltyProfile.findUnique({
      where: { userId },
      select: {
        balance: true,
        lifetimePoints: true,
        yearPoints: true,
        tier: true,
      },
    });

    if (!profile) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `Profile not found for user ${userId}`,
      });
    }

    return {
      balance: profile.balance,
      lifetimePoints: profile.lifetimePoints,
      yearPoints: profile.yearPoints,
      tier: LoyaltyMapper.toGrpcTier(profile.tier),
    };
  }

  async getFullProfile(userId: string): Promise<GetFullProfileResponse> {
    const profile = await this.prisma.loyaltyProfile.findUnique({
      where: { userId },
    });

    if (!profile) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `Loyalty profile not found for user ${userId}`,
      });
    }

    return {
      userId: profile.userId,
      tier: LoyaltyMapper.toGrpcTier(profile.tier),
      balance: profile.balance,
      lifetimePoints: profile.lifetimePoints,
      yearPoints: profile.yearPoints,
      yearVisits: profile.yearVisits,
      tierExpiresAt: profile.tierExpiresAt?.toISOString() ?? '',
      balanceExpiresAt: profile.balanceExpiresAt?.toISOString() ?? '',
      isBirthdayWeek: this.calculator.isBirthdayWeek(profile.birthdayDate),
      goldUpgradeAvailable: this.isGoldUpgradeAvailable(
        profile.tier,
        profile.goldUpgradeUsedMonth,
      ),
    };
  }

  async deductPoints(
    userId: string,
    amount: number,
    orderId: string,
    idempotencyKey: string,
  ): Promise<DeductPointsResponse> {
    if (amount < LOYALTY_RULES.MINIMUM_DEDUCTION) {
      return {
        success: false,
        balanceAfter: 0,
        errorMessage: `Minimum deduction is ${LOYALTY_RULES.MINIMUM_DEDUCTION} points`,
      };
    }

    try {
      const result = await this.prisma.$transaction(async (trx) => {
        const alreadyProcessed = await trx.processedEvent.findUnique({
          where: { eventId: idempotencyKey },
        });

        if (alreadyProcessed) {
          const profile = await trx.loyaltyProfile.findFirstOrThrow({
            where: { userId },
            select: { balance: true },
          });
          return {
            success: true,
            balanceAfter: profile.balance,
          };
        }

        const profile = await trx.loyaltyProfile.findUnique({
          where: { userId },
        });

        if (!profile) {
          throw new RpcException({
            code: GrpcStatus.NOT_FOUND,
            message: `Profile not found for user ${userId}`,
          });
        }

        if (profile.balance < amount) {
          return {
            success: false,
            balanceAfter: profile.balance,
            errorMessage: 'Insufficient points balance',
          };
        }

        const newBalance = profile.balance - amount;

        await trx.loyaltyProfile.update({
          where: { id: profile.id },
          data: {
            balance: newBalance,
            lastActivityAt: new Date(),
          },
        });

        await trx.pointsTransaction.create({
          data: {
            userId,
            type: PointsTransactionType.BURN_DISCOUNT,
            points: -amount,
            balanceAfter: newBalance,
            orderId,
            description: `Redeemed ${amount} pts for order ${orderId}`,
          },
        });

        await trx.processedEvent.create({
          data: { eventId: idempotencyKey },
        });

        return { success: true, balanceAfter: newBalance };
      });

      return result;
    } catch (error: unknown) {
      if (error instanceof RpcException) throw error;

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`DeductPoints failed for user ${userId}: ${message}`);

      return {
        success: false,
        balanceAfter: 0,
        errorMessage: 'Internal error',
      };
    }
  }

  async useGoldUpgrade(
    userId: string,
    orderId: string,
  ): Promise<UseGoldUpgradeResponse> {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const currentMonth = `${now.getFullYear()}-${month}`;

    try {
      const updated = await this.prisma.loyaltyProfile.updateMany({
        where: {
          userId,
          tier: Tier.GOLD,
          OR: [
            { goldUpgradeUsedMonth: null },
            { goldUpgradeUsedMonth: { not: currentMonth } },
          ],
        },
        data: { goldUpgradeUsedMonth: currentMonth },
      });

      if (updated.count === 0) {
        const profile = await this.prisma.loyaltyProfile.findUnique({
          where: { userId },
          select: { tier: true, goldUpgradeUsedMonth: true },
        });

        if (!profile) {
          throw new RpcException({
            code: GrpcStatus.NOT_FOUND,
            message: `Profile not found for user ${userId}`,
          });
        }

        if (profile.tier !== Tier.GOLD) {
          return { success: false, errorMessage: 'User is not GOLD tier' };
        }

        return {
          success: false,
          errorMessage: 'Gold upgrade quota exceeded for this month',
        };
      }

      this.logger.log(`Gold upgrade used by ${userId} for order ${orderId}`);
      return { success: true };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`useGoldUpgrade failed for ${userId}: ${message}`);
      throw new RpcException({
        code: GrpcStatus.INTERNAL,
        message: 'Internal error during gold upgrade',
      });
    }
  }

  async processTicketPurchase(msg: TicketPurchasedDto): Promise<void> {
    try {
      await this.prisma.$transaction(async (trx) => {
        const alreadyProcessed = await trx.processedEvent.findUnique({
          where: { eventId: msg.eventId },
        });

        if (alreadyProcessed) {
          this.logger.warn(`Event ${msg.eventId} already processed. Skipping.`);
          return;
        }

        const profile = await this.findOrCreateProfile(msg.userId, trx);
        const multiplier = this.calculator.resolveMultiplier(
          profile,
          msg.eventType,
        );
        const pointsEarned = Math.floor(msg.totalAmount * multiplier);

        const newBalance = profile.balance + pointsEarned;
        const newLifetime = profile.lifetimePoints + pointsEarned;
        const newYearPoints = profile.yearPoints + pointsEarned;
        const newYearVisits = profile.yearVisits + 1;

        const newTier = this.calculator.resolveNewTier(
          profile.tier,
          newYearVisits,
          newYearPoints,
        );

        await trx.loyaltyProfile.update({
          where: { id: profile.id },
          data: {
            balance: newBalance,
            lifetimePoints: newLifetime,
            yearPoints: newYearPoints,
            yearVisits: newYearVisits,
            tier: newTier,
            lastActivityAt: new Date(),
            balanceExpiresAt: this.calculator.addYears(new Date(), 1),
          },
        });

        await trx.pointsTransaction.create({
          data: {
            userId: msg.userId,
            type: this.calculator.resolveTransactionType(msg.eventType),
            points: pointsEarned,
            balanceAfter: newBalance,
            orderId: msg.orderId,
            description: `Earned ${pointsEarned} pts for order ${msg.orderId} (${msg.eventType})`,
          },
        });

        await trx.processedEvent.create({
          data: { eventId: msg.eventId },
        });

        this.logger.log(
          `[${msg.userId}] +${pointsEarned} pts | balance: ${newBalance} | tier: ${newTier}`,
        );

        if (newTier !== profile.tier) {
          const upgradePayload = {
            userId: msg.userId,
            oldTier: profile.tier,
            newTier,
          };

          await trx.outboxEvent.create({
            data: {
              type: 'loyalty.tier_upgraded',
              payload: upgradePayload,
              aggregateType: 'LoyaltyProfile',
              aggregateId: msg.userId,
            },
          });

          this.logger.log(
            `[${msg.userId}] Tier upgraded: ${profile.tier} → ${newTier}. Event saved to Outbox.`,
          );
        }
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to process ticket purchase for user ${msg.userId}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  // HELPERS

  private async findOrCreateProfile(
    userId: string,
    trx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  ): Promise<LoyaltyProfileSnapshot> {
    const profile = await trx.loyaltyProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    return profile;
  }

  private isGoldUpgradeAvailable(
    tier: Tier,
    goldUpgradeUsedMonth: string | null,
  ): boolean {
    if (tier !== Tier.GOLD) return false;

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;

    return (
      goldUpgradeUsedMonth === null || goldUpgradeUsedMonth !== currentMonth
    );
  }
}
