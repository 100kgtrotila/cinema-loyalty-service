import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import {
  ACHIEVEMENT_JOB_NAME,
  ACHIEVEMENTS_QUEUE,
} from './constants/achievements.constants';
import { GetUserAchievementsRequest } from './interfaces/achievements-request.interface';
import { GetUserAchievementsResponse } from './interfaces/achievements-response.interface';
import { ActionEvent } from './interfaces/action-event.interface';
import { AchievementMapper } from './mappers/achievement.mapper';

@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);

  constructor(
    @InjectQueue(ACHIEVEMENTS_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly mapper: AchievementMapper,
  ) {}

  async dispatchEvent(event: ActionEvent): Promise<void> {
    this.logger.log(
      `Queueing achievement event: eventId=${event.eventId}, userId=${event.userId}, actionType=${event.actionType}`,
    );

    if (event.metadata) {
      this.logger.debug(
        `Achievement event metadata: ${JSON.stringify(event.metadata)}`,
      );
    }

    const job = await this.queue.add(ACHIEVEMENT_JOB_NAME, event);

    this.logger.log(
      `Achievement job queued: jobId=${job.id}, queue=${ACHIEVEMENTS_QUEUE}, jobName=${ACHIEVEMENT_JOB_NAME}, eventId=${event.eventId}`,
    );
  }

  async getUserProgress(userId: string) {
    return this.prisma.userAchievement.findMany({
      where: { userId, achievement: { isActive: true } },
      include: { achievement: true },
      orderBy: [{ isUnlocked: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async getUserAchievementsGrpc(
    req: GetUserAchievementsRequest,
  ): Promise<GetUserAchievementsResponse> {
    const { userId, includeLocked } = req;

    const whereClause: Prisma.UserAchievementWhereInput = {
      userId,
      achievement: { isActive: true },
    };

    if (!includeLocked) {
      whereClause.isUnlocked = true;
    }

    const records = await this.prisma.userAchievement.findMany({
      where: whereClause,
      include: { achievement: true },
      orderBy: [{ updatedAt: 'desc' }],
    });

    return {
      achievements: records.map((r) => this.mapper.toUserAchievementGrpc(r)),
    };
  }
}
