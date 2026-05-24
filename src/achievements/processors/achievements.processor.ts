import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from 'src/prisma/prisma.service';
import { Achievement, AchievementStrategy } from 'src/generated/prisma/client';
import { PointsTransactionType } from 'src/loyalty/events/points-transaction-type.enum';
import { AchievementCriteria } from '../interfaces/achievement-creteria.interface';
import { ActionEvent } from '../interfaces/action-event.interface';
import { z } from 'zod';

const ActionEventSchema = z.object({
  eventId: z.string().uuid(),
  userId: z.string().uuid(),
  actionType: z.string(),
});

@Processor('achievements-queue')
export class AchievementsProcessor extends WorkerHost {
  private readonly logger = new Logger(AchievementsProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<ActionEvent, void, string>): Promise<void> {
    const parsed = ActionEventSchema.safeParse(job.data);
    if (!parsed.success) {
      this.logger.error(`Invalid job payload: ${parsed.error.message}`);
      return;
    }

    const { eventId, userId, actionType } = parsed.data;

    const matchingAchievements = await this.prisma.achievement.findMany({
      where: {
        isActive: true,
        criteria: {
          path: ['field'],
          equals: actionType,
        },
      },
    });

    for (const achievement of matchingAchievements) {
      try {
        await this.processAchievement(eventId, userId, achievement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to process achievement ${achievement.code} for user ${userId}: ${message}`,
        );
      }
    }
  }

  private async processAchievement(
    eventId: string,
    userId: string,
    achievement: Achievement,
  ): Promise<void> {
    const criteria = achievement.criteria as unknown as AchievementCriteria;
    const targetCount = criteria.target || 1;

    await this.prisma.$transaction(async (tx) => {
      const uniqueProcessId = `${eventId}_${achievement.id}`;

      try {
        await tx.processedEvent.create({
          data: { eventId: uniqueProcessId },
        });
      } catch (error: any) {
        if (error.code === 'P2002') {
          this.logger.warn(`Event ${uniqueProcessId} already processed. Skipping.`);
          return;
        }
        throw error;
      }

      const updatedUserAch = await tx.userAchievement.upsert({
        where: {
          userId_achievementId: { userId, achievementId: achievement.id },
        },
        update: {
          current: { increment: 1 },
        },
        create: {
          userId,
          achievementId: achievement.id,
          target: targetCount,
          current: 1,
        },
      });

      if (updatedUserAch.current - 1 >= updatedUserAch.target) {
        return;
      }

      const isNowUnlocked = updatedUserAch.current >= updatedUserAch.target;

      if (isNowUnlocked) {
        await tx.userAchievement.update({
          where: { id: updatedUserAch.id },
          data: {
            isUnlocked: true,
            unlockedAt: new Date(),
          },
        });

        if (achievement.rewardPoints > 0) {
          const updatedProfile = await tx.loyaltyProfile.update({
            where: { userId },
            data: {
              balance: { increment: achievement.rewardPoints },
              lifetimePoints: { increment: achievement.rewardPoints },
            },
          });

          await tx.pointsTransaction.create({
            data: {
              userId,
              points: achievement.rewardPoints,
              type: PointsTransactionType.EARN_ACHIEVEMENT,
              description: `Розблоковано досягнення: ${achievement.name}`,
              balanceAfter: updatedProfile.balance,
            },
          });

          this.logger.log(
            `User ${userId} unlocked achievement ${achievement.code} and received ${achievement.rewardPoints} points!`,
          );
        }
      }
    });
  }
}
