import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACHIEVEMENT_JOB_NAME,
  ACHIEVEMENTS_QUEUE,
} from './constants/achievements.constants';

@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);

  constructor(
    @InjectQueue(ACHIEVEMENTS_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async dispatchEvent(
    eventId: string,
    userId: string,
    actionType: string,
  ): Promise<void> {
    await this.queue.add(
      ACHIEVEMENT_JOB_NAME,
      { eventId, userId, actionType },
      { jobId: eventId },
    );
    this.logger.log(
      `Dispatched event ${actionType} for user ${userId} with eventId ${eventId}`,
    );
  }

  async getAvailableAchievements() {
    return this.prisma.achievement.findMany();
  }

  async getUserProgress(userId: string) {
    return this.prisma.userAchievement.findMany({
      where: { userId },
      include: { achievement: true },
    });
  }
}
