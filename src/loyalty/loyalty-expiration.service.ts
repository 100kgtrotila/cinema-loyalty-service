import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  lockLoyaltyProfile,
  withTransactionRetry,
} from 'src/prisma/profile-transaction';
import {
  BATCH_SIZE,
  INJECTION_TOKENS,
  NOTIFY_DAYS_BEFORE,
  RABBITMQ_EVENTS,
  TIME_CONSTANTS,
} from './constants/loyalty.constants';
import { ClientProxy } from '@nestjs/microservices';
import { RefundPointsResponse } from './interfaces/loyalty-response.interface';
import { PointsTransactionType } from './events/points-transaction-type.enum';
import {
  parsePointCommand,
  replayPointCommand,
  claimPointCommand,
} from './point-command-idempotency';
import {
  ERROR_MESSAGES,
  TRANSACTION_DESCRIPTIONS,
} from './constants/loyalty.constants';

@Injectable()
export class LoyaltyExpirationService {
  private readonly logger = new Logger(LoyaltyExpirationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT)
    private readonly rabbitClient: ClientProxy,
  ) {}

  async notifyExpiringUsers(
    onProgress?: (processedTotal: number) => Promise<void>,
  ): Promise<void> {
    const now = new Date();

    const thirtyDaysFromNow = new Date(
      now.getTime() + NOTIFY_DAYS_BEFORE * TIME_CONSTANTS.MS_IN_A_DAY,
    );
    const notifiedBefore = new Date(
      now.getTime() - NOTIFY_DAYS_BEFORE * TIME_CONSTANTS.MS_IN_A_DAY,
    );

    let lastSeenId: string | undefined;
    let total = 0;

    do {
      const batch = await this.prisma.loyaltyProfile.findMany({
        where: {
          ...(lastSeenId ? { id: { lt: lastSeenId } } : {}),
          balance: { gt: 0 },
          balanceExpiresAt: { gte: now, lte: thirtyDaysFromNow },
          OR: [
            { lastExpiryNotificationAt: null },
            { lastExpiryNotificationAt: { lt: notifiedBefore } },
          ],
        },
        select: {
          id: true,
          userId: true,
          balance: true,
          balanceExpiresAt: true,
        },
        take: BATCH_SIZE,
        orderBy: { id: 'desc' },
      });

      if (batch.length === 0) break;

      lastSeenId = batch[batch.length - 1]?.id;

      await this.prisma.loyaltyProfile.updateMany({
        where: { id: { in: batch.map((p) => p.id) } },
        data: {
          lastExpiryNotificationAt: now,
        },
      });

      for (const profile of batch) {
        this.rabbitClient.emit(RABBITMQ_EVENTS.POINTS_EXPIRING, {
          userId: profile.userId,
          points: profile.balance,
          expiresAt: profile.balanceExpiresAt?.toISOString(),
        });
      }

      total += batch.length;
      if (onProgress) await onProgress(total);
    } while (lastSeenId);
    this.logger.log(
      `[notify-expiring] Завершено. Відправлено сповіщень у RabbitMQ: ${total}`,
    );
  }

  async expirePoints(
    onProgress?: (processedTotal: number) => Promise<void>,
  ): Promise<void> {
    const now = new Date();
    let total = 0;
    let lastSeenId: string | undefined;

    do {
      const batch = await this.prisma.loyaltyProfile.findMany({
        where: {
          ...(lastSeenId ? { id: { lt: lastSeenId } } : {}),
          balance: { gt: 0 },
          balanceExpiresAt: { lte: now },
        },
        select: { id: true, userId: true },
        take: BATCH_SIZE,
        orderBy: { id: 'desc' },
      });

      if (batch.length === 0) break;

      lastSeenId = batch[batch.length - 1]?.id;

      for (const candidate of batch) {
        const expired = await withTransactionRetry(this.prisma, async (tx) => {
          if (!(await lockLoyaltyProfile(tx, candidate.userId))) return false;
          const profile = await tx.loyaltyProfile.findUnique({
            where: { userId: candidate.userId },
          });
          if (
            !profile ||
            profile.balance <= 0 ||
            !profile.balanceExpiresAt ||
            profile.balanceExpiresAt > now
          ) {
            return false;
          }
          await tx.loyaltyProfile.update({
            where: { id: profile.id },
            data: { balance: 0 },
          });
          await tx.pointsTransaction.create({
            data: {
              userId: profile.userId,
              type: PointsTransactionType.EXPIRE,
              points: -profile.balance,
              balanceAfter: 0,
              description: TRANSACTION_DESCRIPTIONS.POINTS_EXPIRED,
            },
          });
          return true;
        });
        if (expired) total += 1;
      }

      if (onProgress) await onProgress(total);

      this.logger.log(
        `[expire-points] Оброблено пачку з ${batch.length} юзерів. Загалом: ${total}`,
      );
    } while (lastSeenId);

    this.logger.log(
      `[expire-points] Успішно завершено! Всього обнулено: ${total}`,
    );
  }

  async resetAnnualStats(
    onProgress?: (processedTotal: number) => Promise<void>,
  ): Promise<void> {
    let lastSeenId: string | undefined;
    let total = 0;

    do {
      const batch = await this.prisma.loyaltyProfile.findMany({
        where: {
          ...(lastSeenId ? { id: { lt: lastSeenId } } : {}),
          OR: [{ yearPoints: { gt: 0 } }, { yearVisits: { gt: 0 } }],
        },
        select: { id: true, userId: true },
        take: BATCH_SIZE,
        orderBy: { id: 'desc' },
      });

      if (batch.length === 0) break;
      lastSeenId = batch[batch.length - 1]?.id;

      for (const profile of batch) {
        await withTransactionRetry(this.prisma, async (tx) => {
          if (!(await lockLoyaltyProfile(tx, profile.userId))) return;
          await tx.loyaltyProfile.updateMany({
            where: { id: profile.id },
            data: { yearPoints: 0, yearVisits: 0 },
          });
        });
      }

      total += batch.length;
      if (onProgress) await onProgress(total);
    } while (lastSeenId);

    this.logger.log(
      `[annual-stats-reset] Завершено. Скинуто річну статистику для ${total} юзерів.`,
    );
  }

  async goldReset(
    onProgress?: (processedTotal: number) => Promise<void>,
  ): Promise<void> {
    let lastSeenId: string | undefined;
    let total = 0;

    do {
      const batch = await this.prisma.loyaltyProfile.findMany({
        where: {
          ...(lastSeenId ? { id: { lt: lastSeenId } } : {}),
          goldUpgradeUsedMonth: { not: null },
        },
        select: { id: true },
        take: BATCH_SIZE,
        orderBy: { id: 'desc' },
      });

      if (batch.length === 0) break;
      lastSeenId = batch[batch.length - 1]?.id;

      await this.prisma.loyaltyProfile.updateMany({
        where: { id: { in: batch.map((p) => p.id) } },
        data: {
          goldUpgradeUsedMonth: null,
        },
      });

      total += batch.length;
      if (onProgress) await onProgress(total);
    } while (lastSeenId);

    this.logger.log(
      `[gold-reset] Завершено. Оновлено квоти для ${total} юзерів.`,
    );
  }

  async refundPoints(
    userId: string,
    amount: number,
    orderId: string,
    idempotencyKey: string,
  ): Promise<RefundPointsResponse> {
    const command = parsePointCommand({
      operation: 'REFUND',
      userId,
      amount,
      orderId,
      idempotencyKey,
    });
    if (!command)
      return {
        success: false,
        balanceAfter: 0,
        errorMessage: ERROR_MESSAGES.INVALID_POINT_COMMAND,
      };
    try {
      return await withTransactionRetry(this.prisma, async (trx) => {
        const profileLocked = await lockLoyaltyProfile(trx, command.userId);
        const replay = await replayPointCommand(trx, command);
        if (replay) return replay;

        const profile = profileLocked
          ? await trx.loyaltyProfile.findUnique({ where: { userId } })
          : null;
        if (!profile)
          return {
            success: false,
            balanceAfter: 0,
            errorMessage: ERROR_MESSAGES.PROFILE_NOT_FOUND,
          };

        const newBalance = profile.balance + amount;
        const racedReplay = await claimPointCommand(trx, command, newBalance);
        if (racedReplay) return racedReplay;

        await trx.loyaltyProfile.update({
          where: { userId },
          data: { balance: newBalance },
        });

        await trx.pointsTransaction.create({
          data: {
            userId,
            type: PointsTransactionType.REFUND,
            points: amount,
            balanceAfter: newBalance,
            orderId,
            description: `Refund for failed order ${orderId}`,
          },
        });

        return { success: true, balanceAfter: newBalance, errorMessage: '' };
      });
    } catch (error) {
      this.logger.error(
        `Failed to refund points for order ${orderId}: ${error}`,
      );
      return {
        success: false,
        balanceAfter: 0,
        errorMessage: ERROR_MESSAGES.INTERNAL_REFUND,
      };
    }
  }
}
