import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import type { Achievement } from 'src/generated/prisma/client';
import { PointsTransactionType } from 'src/loyalty/events/points-transaction-type.enum';
import { PrismaService } from 'src/prisma/prisma.service';
import { ACHIEVEMENTS_QUEUE } from '../constants/achievements.constants';
import { calculateAchievementProgressIncrement } from '../helpers/achievement-progress.helper';
import { ActionEvent } from '../interfaces/action-event.interface';
import { AchievementCriteriaSchema } from '../schemas/achievement-criteria.schemas';
import { ActionEventSchema } from '../schemas/events.schemas';

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
      throw new Error(
        `Invalid achievement job payload: ${parsed.error.message}`,
      );
    }

    const event = parsed.data;
    const { eventId, userId, actionType } = event;

    this.logger.log(
      `Processing achievement job: jobId=${job.id}, queue=${job.queueName}, jobName=${job.name}, eventId=${eventId}, userId=${userId}, actionType=${actionType}`,
    );

    if (event.metadata) {
      this.logger.debug(
        `Achievement processing metadata: ${JSON.stringify(event.metadata)}`,
      );
    }

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

    const failures: string[] = [];

    for (const achievement of matchingAchievements) {
      try {
        await this.processAchievement(eventId, userId, achievement, event);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;

        failures.push(`${achievement.code}: ${message}`);
        this.logger.error(
          `Failed to process achievement ${achievement.code} for user ${userId}: ${message}`,
          stack,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Failed to process ${failures.length}/${matchingAchievements.length} achievements for event ${eventId}: ${failures.join('; ')}`,
      );
    }
  }

  private async processAchievement(
    eventId: string,
    userId: string,
    achievement: Achievement,
    event: ActionEvent,
  ): Promise<void> {
    const criteriaResult = AchievementCriteriaSchema.safeParse(
      achievement.criteria,
    );

    if (!criteriaResult.success) {
      this.logger.warn(
        `Achievement ${achievement.code} has invalid criteria: ${criteriaResult.error.message}`,
      );
      return;
    }

    const criteria = criteriaResult.data;
    const { target: targetCount } = criteria;
    const { incrementBy, shouldProcess } =
      calculateAchievementProgressIncrement(criteria, event);

    if (!shouldProcess) return;

    const uniqueProcessId = `${eventId}_${achievement.id}`;

    await this.prisma.$transaction(async (tx) => {
      const idempotency = await tx.processedEvent.createMany({
        data: { eventId: uniqueProcessId },
        skipDuplicates: true,
      });

      if (idempotency.count === 0) {
        this.logger.warn(
          `Event ${uniqueProcessId} already processed. Skipping.`,
        );
        return;
      }

      const achievementRef = {
        userId_achievementId: { userId, achievementId: achievement.id },
      };

      const existingUserAchievement = await tx.userAchievement.findUnique({
        where: achievementRef,
      });

      if (existingUserAchievement?.isUnlocked) {
        return;
      }

      const updatedUserAchievement = existingUserAchievement
        ? await tx.userAchievement.update({
            where: { id: existingUserAchievement.id },
            data: {
              current: { increment: incrementBy },
              target: targetCount,
            },
          })
        : await tx.userAchievement.create({
            data: {
              userId,
              achievementId: achievement.id,
              target: targetCount,
              current: incrementBy,
            },
          });

      if (updatedUserAchievement.current < updatedUserAchievement.target) {
        return;
      }

      const unlocked = await tx.userAchievement.updateMany({
        where: {
          id: updatedUserAchievement.id,
          isUnlocked: false,
        },
        data: {
          isUnlocked: true,
          unlockedAt: new Date(),
        },
      });

      if (unlocked.count === 0) return;

      if (achievement.rewardPoints <= 0) {
        this.logger.log(
          `User ${userId} unlocked achievement "${achievement.code}"`,
        );
        return;
      }

      const updatedProfile = await tx.loyaltyProfile.upsert({
        where: { userId },
        update: {
          balance: { increment: achievement.rewardPoints },
          lifetimePoints: { increment: achievement.rewardPoints },
        },
        create: {
          userId,
          balance: achievement.rewardPoints,
          lifetimePoints: achievement.rewardPoints,
        },
      });

      await tx.pointsTransaction.create({
        data: {
          userId,
          points: achievement.rewardPoints,
          type: PointsTransactionType.EARN_ACHIEVEMENT,
          description: `Unlocked achievement: ${achievement.name}`,
          balanceAfter: updatedProfile.balance,
        },
      });

      this.logger.log(
        `User ${userId} unlocked achievement "${achievement.code}" (+${achievement.rewardPoints} pts)`,
      );
    });
  }
}
