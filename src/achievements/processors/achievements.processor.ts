import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from 'src/prisma/prisma.service';
import { Achievement, Prisma } from 'src/generated/prisma/client';
import { PointsTransactionType } from 'src/loyalty/events/points-transaction-type.enum';
import { ActionEvent } from '../interfaces/action-event.interface';
import { ActionEventSchema, CriteriaSchema } from '../schemas/events.schemas';
import { ACHIEVEMENTS_QUEUE } from '../constants/achievements.constants';

@Processor(ACHIEVEMENTS_QUEUE)
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

    const event = job.data;

    this.logger.log(
      `Processing achievement job: jobId=${job.id}, queue=${job.queueName}, jobName=${job.name}, eventId=${event.eventId}, userId=${event.userId}, actionType=${event.actionType}`,
    );

    if (event.metadata) {
      this.logger.debug(
        `Achievement processing metadata: ${JSON.stringify(event.metadata)}`,
      );
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

    this.logger.debug(
      `Found ${matchingAchievements.length} achievements for action ${actionType}`,
    );

    for (const achievement of matchingAchievements) {
      try {
        await this.processAchievement(
          eventId,
          userId,
          achievement,
          parsed.data,
        );
      } catch (error: unknown) {
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
    event: ActionEvent,
  ): Promise<void> {
    const criteriaResult = CriteriaSchema.safeParse(achievement.criteria);
    if (!criteriaResult.success) {
      this.logger.warn(
        `Achievement ${achievement.code} has invalid criteria: ${criteriaResult.error.message}`,
      );
      return;
    }

    const { target: targetCount, operator, field } = criteriaResult.data;

    let incrementBy = 1;
    if (operator === 'sum') {
      const raw = event.metadata?.[field];
      const value = typeof raw === 'number' ? raw : Number(raw ?? 0);
      if (value <= 0) return;
      incrementBy = Math.round(value);
    }

    const uniqueProcessId = `${eventId}_${achievement.id}`;

    try {
      await this.prisma.processedEvent.create({
        data: { eventId: uniqueProcessId },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.warn(
          `Event ${uniqueProcessId} already processed. Skipping.`,
        );
        return;
      }
      throw error;
    }

    await this.prisma.$transaction(async (tx) => {
      const updatedUserAch = await tx.userAchievement.upsert({
        where: {
          userId_achievementId: { userId, achievementId: achievement.id },
        },
        update: { current: { increment: incrementBy } },
        create: {
          userId,
          achievementId: achievement.id,
          target: targetCount,
          current: incrementBy,
        },
      });

      if (updatedUserAch.current - incrementBy >= updatedUserAch.target) return;

      const isNowUnlocked = updatedUserAch.current >= updatedUserAch.target;

      if (isNowUnlocked) {
        await tx.userAchievement.update({
          where: { id: updatedUserAch.id },
          data: { isUnlocked: true, unlockedAt: new Date() },
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
            `User ${userId} unlocked achievement "${achievement.code}" (+${achievement.rewardPoints} pts)`,
          );
        }
      }
    });
  }
}
