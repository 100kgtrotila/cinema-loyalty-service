import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminTransactionType } from '../loyalty/constants/admin-loyalty.constants';
import { LoyaltyCalculatorService } from '../loyalty/loyalty-calculator.service';
import { OutboxEventType, AggregateType } from '../loyalty/enums/loyalty.enums';
import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';
import { LoyaltyMapper } from 'src/utils/loyalty.mapper';
import { Prisma, Tier } from 'src/generated/prisma/client';

@Injectable()
export class AdminLoyaltyService {
  private readonly logger = new Logger(AdminLoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: LoyaltyCalculatorService,
  ) {}

  async getUserBalanceGrpc(userId: string) {
    const profile = await this.prisma.loyaltyProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { balance: true, tier: true, lifetimePoints: true },
    });

    return {
      balance: profile.balance,
      lifetimePoints: profile.lifetimePoints,
      tier: LoyaltyMapper.toGrpcTier(profile.tier),
    };
  }

  async getTransactionHistoryGrpc(
    userId: string,
    limit: number = 50,
    skip: number = 0,
  ) {
    const history = await this.prisma.pointsTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: skip,
    });

    const transactions = history.map((t) => ({
      id: t.id,
      type: t.type,
      points: t.points,
      balanceAfter: t.balanceAfter,
      orderId: t.orderId ?? '',
      description: t.description ?? '',
      createdAt: t.createdAt.toISOString(),
    }));

    return { transactions };
  }

  async modifyPointsGrpc(
    userId: string,
    adminId: string,
    points: number,
    reason: string,
  ) {
    if (points === 0) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'Points modification value must be non-zero.',
      });
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const profile = await tx.loyaltyProfile.upsert({
          where: { userId },
          create: { userId },
          update: {},
        });

        if (profile.balance + points < 0) {
          throw new RpcException({
            code: GrpcStatus.INVALID_ARGUMENT,
            message: 'Insufficient points for deduction.',
          });
        }

        const lifetimeIncrement = points > 0 ? points : 0;
        const yearIncrement = points > 0 ? points : 0;

        const newTier = this.calculator.resolveNewTier(
          profile.tier,
          profile.yearVisits,
          profile.yearPoints + yearIncrement,
        );

        const updatedProfile = await tx.loyaltyProfile.update({
          where: { userId },
          data: {
            balance: { increment: points },
            lifetimePoints: { increment: lifetimeIncrement },
            yearPoints: { increment: yearIncrement },
            tier: newTier,
            lastActivityAt: new Date(),
            ...(points > 0 && {
              balanceExpiresAt: this.calculator.addYears(new Date(), 1),
            }),
          },
        });

        const transactionType =
          points > 0
            ? AdminTransactionType.ADDITION
            : AdminTransactionType.DEDUCTION;

        await tx.pointsTransaction.create({
          data: {
            userId,
            type: transactionType,
            points,
            balanceAfter: updatedProfile.balance,
            description: `[Admin: ${adminId}] Reason: ${reason}`,
          },
        });

        if (newTier !== profile.tier) {
          const upgradePayload = {
            userId,
            oldTier: profile.tier,
            newTier,
          };

          await tx.outboxEvent.create({
            data: {
              type: OutboxEventType.TIER_UPGRADED,
              payload: upgradePayload,
              aggregateType: AggregateType.LOYALTY_PROFILE,
              aggregateId: userId,
            },
          });

          this.logger.log(
            `[${userId}] Tier upgraded by admin: ${profile.tier} → ${newTier}. Event saved to Outbox.`,
          );
        }

        return updatedProfile;
      });

      return {
        userId: result.userId,
        tier: LoyaltyMapper.toGrpcTier(result.tier),
        balance: result.balance,
        success: true,
      };
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }

      this.logger.error(
        `Failed to modify points for user ${userId} by admin ${adminId}: ${error}`,
      );
      throw new RpcException({
        code: GrpcStatus.INTERNAL,
        message: 'An error occurred while modifying points.',
      });
    }
  }

  async getUsersGrpc(
    limit: number,
    skip: number,
    tierFilter?: string,
    userIds?: string[],
  ) {
    const whereClause: Prisma.LoyaltyProfileWhereInput = {};

    if (tierFilter) {
      whereClause.tier = tierFilter as Tier;
    }

    if (userIds && userIds.length > 0) {
      whereClause.userId = { in: userIds };
    }

    const [profiles, totalCount] = await Promise.all([
      this.prisma.loyaltyProfile.findMany({
        where: whereClause,
        orderBy: { lifetimePoints: 'desc' },
        take: limit,
        skip: skip,
      }),
      this.prisma.loyaltyProfile.count({ where: whereClause }),
    ]);

    return {
      profiles: profiles.map((p) => ({
        userId: p.userId,
        tier: LoyaltyMapper.toGrpcTier(p.tier),
        balance: p.balance,
        lifetimePoints: p.lifetimePoints,
      })),
      totalCount,
    };
  }

  async grantVipStatusGrpc(userId: string, adminId: string, reason: string) {
    const profile = await this.prisma.loyaltyProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    if (profile.tier === 'GOLD') {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'User is already a VIP (GOLD tier).',
      });
    }

    const updatedProfile = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.loyaltyProfile.update({
        where: { userId },
        data: { tier: 'GOLD' },
      });

      await tx.pointsTransaction.create({
        data: {
          userId,
          type: AdminTransactionType.ADDITION,
          points: 0,
          balanceAfter: updated.balance,
          description: `[Admin: ${adminId}] VIP Status Granted. Reason: ${reason}`,
        },
      });

      await tx.outboxEvent.create({
        data: {
          type: OutboxEventType.TIER_UPGRADED,
          payload: { userId, oldTier: profile.tier, newTier: 'GOLD' },
          aggregateType: AggregateType.LOYALTY_PROFILE,
          aggregateId: userId,
        },
      });

      return updated;
    });

    this.logger.log(`[${userId}] VIP Status granted by admin ${adminId}`);

    return {
      userId: updatedProfile.userId,
      newTier: LoyaltyMapper.toGrpcTier(updatedProfile.tier),
      success: true,
    };
  }
}
