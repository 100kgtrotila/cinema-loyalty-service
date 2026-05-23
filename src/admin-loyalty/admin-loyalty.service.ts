import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminTransactionType } from './constants/admin-loyalty.constants';

@Injectable()
export class AdminLoyaltyService {
  private readonly logger = new Logger(AdminLoyaltyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getUserBalance(userId: string) {
    const profile = await this.prisma.loyaltyProfile.findUnique({
      where: { userId },
      select: { balance: true, tier: true, lifetimePoints: true },
    });

    if (!profile) {
      throw new NotFoundException(
        `Loyalty profile for user ${userId} not found.`,
      );
    }

    return profile;
  }

  async getTransactionHistory(
    userId: string,
    limit: number = 50,
    skip: number = 0,
  ) {
    return this.prisma.pointsTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: skip,
    });
  }

  async modifyPoints(
    userId: string,
    adminId: string,
    points: number,
    reason: string,
  ) {
    if (points === 0) {
      throw new BadRequestException(
        'Points modification value must be non-zero.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const profile = await tx.loyaltyProfile.findUnique({
          where: { userId },
        });

        if (!profile) {
          throw new NotFoundException(
            `Loyalty profile for user ${userId} not found.`,
          );
        }

        const newBalance = profile.balance + points;

        if (newBalance < 0) {
          throw new BadRequestException('Insufficient points for deduction.');
        }

        const updatedProfile = await tx.loyaltyProfile.update({
          where: { userId },
          data: {
            balance: newBalance,
            lifetimePoints:
              points > 0
                ? profile.lifetimePoints + points
                : profile.lifetimePoints,
            yearPoints:
              points > 0 ? profile.yearPoints + points : profile.yearPoints,
          },
        });

        const transactionType =
          points > 0
            ? AdminTransactionType.ADDITION
            : AdminTransactionType.DEDUCTION;

        const transaction = await tx.pointsTransaction.create({
          data: {
            userId,
            type: transactionType,
            points,
            balanceAfter: newBalance,
            description: `[Admin: ${adminId}] Reason: ${reason}`,
          },
        });

        return {
          profile: updatedProfile,
          transaction,
        };
      });
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      this.logger.error(
        `Failed to modify points for user ${userId} by admin ${adminId}: ${error}`,
      );
      throw new InternalServerErrorException(
        'An error occurred while modifying points.',
      );
    }
  }
}
