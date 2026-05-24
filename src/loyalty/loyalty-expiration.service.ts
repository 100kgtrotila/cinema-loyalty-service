import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
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
import { ERROR_MESSAGES, TRANSACTION_DESCRIPTIONS } from './constants/loyalty.constants';

@Injectable()
export class LoyaltyExpirationService {
  private readonly logger = new Logger(LoyaltyExpirationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT)
    private readonly rabbitClient: ClientProxy,
  ) { }

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

    let cursor: string | undefined;
    let total = 0;

    do {
      const batch = await this.prisma.loyaltyProfile.findMany({
        where: {
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
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'desc' },
      });

      if (batch.length === 0) break;

      cursor = batch[batch.length - 1]?.id;

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
    } while (cursor);
    this.logger.log(
      `[notify-expiring] Завершено. Відправлено сповіщень у RabbitMQ: ${total}`,
    );
  }

  async expirePoints(
    onProgress?: (processedTotal: number) => Promise<void>,
  ): Promise<void> {
    const now = new Date();
    let total = 0;
    let cursor: string | undefined;

    do {
      const batch = await this.prisma.loyaltyProfile.findMany({
        where: { balance: { gt: 0 }, balanceExpiresAt: { lte: now } },
        select: { id: true, userId: true, balance: true },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'desc' },
      });

      if (batch.length === 0) break;

      cursor = batch[batch.length - 1]?.id;

      await this.prisma.$transaction([
        this.prisma.loyaltyProfile.updateMany({
          where: { id: { in: batch.map((p) => p.id) } },
          data: { balance: 0 },
        }),
        this.prisma.pointsTransaction.createMany({
          data: batch.map((p) => ({
            userId: p.userId,
            type: PointsTransactionType.EXPIRE,
            points: -p.balance,
            balanceAfter: 0,
            description: TRANSACTION_DESCRIPTIONS.POINTS_EXPIRED,
          })),
        }),
      ]);

      total += batch.length;

      if (onProgress) await onProgress(total);

      this.logger.log(
        `[expire-points] Оброблено пачку з ${batch.length} юзерів. Загалом: ${total}`,
      );
    } while (cursor);

    this.logger.log(
      `[expire-points] Успішно завершено! Всього обнулено: ${total}`,
    );
  }

  async annualReset(
    onProgress?: (processedTotal: number) => Promise<void>,
  ): Promise<void> {
    let cursor: string | undefined;
    let total = 0;

    do {
      const batch = await this.prisma.loyaltyProfile.findMany({
        where: {
          OR: [{ yearPoints: { gt: 0 } }, { yearVisits: { gt: 0 } }],
        },
        select: { id: true },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'desc' },
      });

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]?.id;

      await this.prisma.loyaltyProfile.updateMany({
        where: { id: { in: batch.map((p) => p.id) } },
        data: {
          yearPoints: 0,
          yearVisits: 0,
        },
      });

      total += batch.length;
      if (onProgress) await onProgress(total);
    } while (cursor);

    this.logger.log(
      `[annual-reset] Завершено. Скинуто статистику для ${total} юзерів.`,
    );
  }

  async goldReset(
    onProgress?: (processedTotal: number) => Promise<void>,
  ): Promise<void> {
    let cursor: string | undefined;
    let total = 0;

    do {
      const batch = await this.prisma.loyaltyProfile.findMany({
        where: {
          goldUpgradeUsedMonth: { not: null },
        },
        select: { id: true },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'desc' },
      });

      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]?.id;

      await this.prisma.loyaltyProfile.updateMany({
        where: { id: { in: batch.map((p) => p.id) } },
        data: {
          goldUpgradeUsedMonth: null,
        },
      });

      total += batch.length;
      if (onProgress) await onProgress(total);
    } while (cursor);

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
    try {
      return await this.prisma.$transaction(async (trx) => {
        const alreadyProcessed = await trx.processedEvent.findUnique({
          where: { eventId: idempotencyKey },
        });

        if (alreadyProcessed) {
          const profile = await trx.loyaltyProfile.findUnique({
            where: { userId },
          });
          return {
            success: true,
            balanceAfter: profile?.balance || 0,
            errorMessage: '',
          };
        }

        const profile = await trx.loyaltyProfile.findUnique({
          where: { userId },
        });
        if (!profile)
          return {
            success: false,
            balanceAfter: 0,
            errorMessage: ERROR_MESSAGES.PROFILE_NOT_FOUND,
          };

        const newBalance = profile.balance + amount;

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
        await trx.processedEvent.create({
          data: { eventId: idempotencyKey },
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
