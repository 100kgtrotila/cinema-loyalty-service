import EventEmitter2 from 'eventemitter2';
import { Tier } from 'src/generated/prisma/enums';
import { PrismaService } from 'src/prisma/prisma.service';
import { LOYALTY_RULES } from '../constants/loyalty.constants';
import { Cron } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class LoyaltySchedulerService {
  private readonly logger = new Logger(LoyaltySchedulerService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  @Cron('0 3 * * *')
  async expirePoints(): Promise<void> {
    await this.
  }

  async notifyExpiringPoints(): Promise<void> {
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const profilesToNotify = await this.prisma.loyaltyProfile.findMany({
      where: {
        balance: { gt: 0 },
        balanceExpiresAt: {
          gte: new Date(),
          lte: thirtyDaysFromNow,
        },
      },
      select: {
        userId: true,
        balance: true,
        balanceExpiresAt: true,
      },
    });

    for (const profile of profilesToNotify) {
      this.emitter.emit('loyalty.points_expiring', {
        userId: profile.userId,
        points: profile.balance,
        expiredAt: profile.balanceExpiresAt,
      });
    }
    this.logger.log(
      `Notified ${profilesToNotify.length} users about expiring points.`,
    );
  }

  @Cron('0 1 1 * *')
  async resetGoldUpgradeQuota(): Promise<void> {
    this.logger.log('Running resetGoldUpgradeQuota cron...');
  }

  // HELPERS

  private recalculateTier(visits: number, points: number): Tier {
    if (
      visits >= LOYALTY_RULES.TIER_THRESHOLDS.SILVER.visits ||
      points >= LOYALTY_RULES.TIER_THRESHOLDS.SILVER.points
    )
      return Tier.SILVER;

    if (
      visits >= LOYALTY_RULES.TIER_THRESHOLDS.GOLD.visits ||
      points >= LOYALTY_RULES.TIER_THRESHOLDS.GOLD.points
    )
      return Tier.GOLD;

    return Tier.BRONZE;
  }

  private getEndOfTheYear(): Date {
    const date = new Date();
    date.setFullYear(date.getFullYear() + 1, 11, 31);
    date.setHours(23, 59, 59, 999);
    return date;
  }
}
