import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma/client';
import {
  ACHIEVEMENTS_QUEUE,
  ACHIVEMENT_QUEUE_NAME,
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
    await this.queue.add(ACHIVEMENT_QUEUE_NAME, event);
    this.logger.debug(
      `Dispatched achievement event: ${event.actionType} for user ${event.userId}`,
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
