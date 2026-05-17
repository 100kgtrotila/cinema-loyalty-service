import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Tier } from 'src/generated/prisma/enums';
import { TicketPurchasedDto } from './dto/ticked-purchased.dto';
import EventEmitter2 from 'eventemitter2';
import { EventType } from './enums/event-type.enum';
import { PointsTransactionType } from './constants/points-transaction-type.enum';
import { LOYALTY_RULES, TIME_CONSTANTS } from './constants/loyalty.constants';
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

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
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
      return {
        balance: 0,
        lifetimePoints: 0,
        yearPoints: 0,
        tier: LoyaltyMapper.toGrpcTier(Tier.BRONZE),
      };
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
      return {
        userId,
        tier: LoyaltyMapper.toGrpcTier(Tier.BRONZE),
        balance: 0,
        lifetimePoints: 0,
        yearPoints: 0,
        yearVisits: 0,
        tierExpiresAt: '',
        balanceExpiresAt: '',
        isBirthdayWeek: false,
        goldUpgradeAvailable: false,
      };
    }

    const now = new Date();
    const goldUpgradeMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;

    return {
      userId: profile.userId,
      tier: LoyaltyMapper.toGrpcTier(profile.tier),
      balance: profile.balance,
      lifetimePoints: profile.lifetimePoints,
      yearPoints: profile.yearPoints,
      yearVisits: profile.yearVisits,
      tierExpiresAt: profile.tierExpiresAt?.toISOString() ?? '',
      balanceExpiresAt: profile.balanceExpiresAt?.toISOString() ?? '',
      isBirthdayWeek: this.isBirthdayWeek(profile.birthdayDate),
      goldUpgradeAvailable:
        profile.tier === Tier.GOLD &&
        profile.goldUpgradeUsedMonth !== goldUpgradeMonth,
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
        errorMessage: 'Minimum deduction is 75 points',
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
            errorMessage: '',
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
            type: 'BURN_DISCOUNT',
            points: -amount,
            balanceAfter: newBalance,
            orderId,
            description: `Redeemed ${amount} pts for order ${orderId}`,
          },
        });

        await trx.processedEvent.create({
          data: { eventId: idempotencyKey },
        });

        return { success: true, balanceAfter: newBalance, errorMessage: '' };
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
    const profile = await this.prisma.loyaltyProfile.findUnique({
      where: { userId },
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

    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;

    if (profile.goldUpgradeUsedMonth === currentMonth) {
      return {
        success: false,
        errorMessage: 'Gold upgrade quota exceeded for this month',
      };
    }

    await this.prisma.loyaltyProfile.update({
      where: { userId },
      data: { goldUpgradeUsedMonth: currentMonth },
    });

    this.logger.log(`Gold upgrade used by ${userId} for order ${orderId}`);

    return { success: true, errorMessage: '' };
  }

  async processTicketPurchase(msg: TicketPurchasedDto): Promise<void> {
    let tierUpgradePayload: {
      userId: string;
      oldTier: Tier;
      newTier: Tier;
    } | null = null;

    try {
      tierUpgradePayload = await this.prisma.$transaction(async (trx) => {
        const alreadyProcessed = await trx.processedEvent.findUnique({
          where: { eventId: msg.eventId },
        });

        if (alreadyProcessed) {
          this.logger.warn(`Event ${msg.eventId} already processed. Skipping.`);
          return null;
        }

        const profile = await this.findOrCreateProfile(msg.userId, trx);

        const multiplier = this.resolveMultiplier(profile, msg.eventType);

        const pointsEarned = Math.floor(msg.totalAmount * multiplier);

        const newBalance = profile.balance + pointsEarned;
        const newLifetime = profile.lifetimePoints + pointsEarned;
        const newYearPoints = profile.yearPoints + pointsEarned;
        const newYearVisits = profile.yearVisits + 1;
        const newTier = this.checkTierUpgrade(newYearVisits, newYearPoints);

        await trx.loyaltyProfile.update({
          where: { id: profile.id },
          data: {
            balance: newBalance,
            lifetimePoints: newLifetime,
            yearPoints: newYearPoints,
            yearVisits: newYearVisits,
            tier: newTier,
            lastActivityAt: new Date(),
            balanceExpiresAt: this.addYears(new Date(), 1),
          },
        });

        await trx.pointsTransaction.create({
          data: {
            userId: msg.userId,
            type: this.resolveTransactionType(msg.eventType),
            points: pointsEarned,
            balanceAfter: newBalance,
            orderId: msg.orderId,
            description: `Earned ${pointsEarned} pts for order ${msg.orderId} (${msg.eventType})`,
          },
        });

        await trx.processedEvent.create({
          data: {
            eventId: msg.eventId,
          },
        });

        this.logger.log(
          `[${msg.userId}] +${pointsEarned} pts | balance: ${newBalance} | tier: ${newTier}`,
        );

        if (newTier !== profile.tier) {
          return { userId: msg.userId, oldTier: profile.tier, newTier };
        }

        return null;
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

    if (tierUpgradePayload) {
      this.logger.log(
        `[${tierUpgradePayload.userId}] Tier upgraded: ${tierUpgradePayload.oldTier} → ${tierUpgradePayload.newTier}`,
      );
      this.emitter.emit('loyalty.tier_upgraded', tierUpgradePayload);
    }
  }

  // HELPERS

  private async findOrCreateProfile(
    userId: string,
    trx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  ): Promise<LoyaltyProfileSnapshot> {
    const existing = await trx.loyaltyProfile.findUnique({
      where: { userId },
    });

    if (existing) return existing;

    this.logger.log(`Creating new loyalty profile for user ${userId}`);

    return trx.loyaltyProfile.create({
      data: { userId },
    });
  }

  private resolveMultiplier(
    profile: LoyaltyProfileSnapshot,
    eventType: EventType,
  ): number {
    let multiplier = this.getTierMultiplier(profile.tier);

    if (this.isBirthdayWeek(profile.birthdayDate)) {
      multiplier *= this.getBirthdayMultiplier(profile.tier);
    }

    if (eventType === EventType.SPECIAL || eventType === EventType.PREMIERE) {
      multiplier *= LOYALTY_RULES.SPECIAL_EVENT_MULTIPLIER;
    }

    return multiplier;
  }

  private getTierMultiplier(tier: Tier): number {
    return LOYALTY_RULES.TIER_MULTIPLIERS[tier];
  }

  private checkTierUpgrade(visits: number, points: number): Tier {
    const { GOLD, SILVER } = LOYALTY_RULES.TIER_THRESHOLDS;

    if (visits >= GOLD.visits || points >= GOLD.points) return Tier.GOLD;
    if (visits >= SILVER.visits || points >= SILVER.points) return Tier.SILVER;

    return Tier.BRONZE;
  }

  private isBirthdayWeek(birthdayDate: Date | null): boolean {
    if (!birthdayDate) return false;

    const today = new Date();
    const birthday = new Date(birthdayDate);

    birthday.setFullYear(today.getFullYear());

    const diffMs = Math.abs(today.getTime() - birthday.getTime());
    const diffDays = diffMs / TIME_CONSTANTS.MS_IN_A_DAY;

    return diffDays <= LOYALTY_RULES.BIRTHDAY_WEEK_RADIUS_DAYS;
  }

  private getBirthdayMultiplier(tier: Tier): number {
    return LOYALTY_RULES.BIRTHDAY_MULTIPLIERS[tier];
  }

  private resolveTransactionType(eventType: EventType): PointsTransactionType {
    if (eventType === EventType.SPECIAL || eventType === EventType.PREMIERE) {
      return PointsTransactionType.EARN_SPECIAL;
    }
    return PointsTransactionType.EARN_TICKET;
  }

  private addYears(date: Date, years: number): Date {
    const result = new Date(date);
    result.setFullYear(result.getFullYear() + years);
    return result;
  }
}
