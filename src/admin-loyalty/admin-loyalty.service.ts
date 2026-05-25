import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminTransactionType } from './constants/admin-loyalty.constants';
import { LoyaltyCalculatorService } from '../loyalty/loyalty-calculator.service';
import { OutboxEventType, AggregateType } from '../loyalty/enums/loyalty.enums';
import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';
import { LoyaltyMapper } from 'src/utils/loyalty.mapper';

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
}
