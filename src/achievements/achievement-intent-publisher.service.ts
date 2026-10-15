import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { AchievementDispatchIntent } from 'src/generated/prisma/client';
import { CRON_SCHEDULES } from 'src/loyalty/constants/loyalty.constants';
import { AchievementsService } from './achievements.service';
import { ActionEventSchema } from './schemas/events.schemas';

const RETRY_DELAY_MS = 5000;

@Injectable()
export class AchievementIntentPublisher {
  private readonly logger = new Logger(AchievementIntentPublisher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly achievements: AchievementsService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CRON_SCHEDULES.EVERY_5_SECONDS, { waitForCompletion: true })
  async publishPendingIntents(): Promise<void> {
    const intents = await this.prisma.achievementDispatchIntent.findMany({
      where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const results = await Promise.allSettled(
      intents.map((intent) => this.publish(intent)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        const error: unknown = result.reason;
        this.logger.error(
          `Could not record achievement delivery attempt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async publish(intent: AchievementDispatchIntent): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutMs = this.config.getOrThrow<number>(
        'app.outboxPublishTimeoutMs',
      );
      const event = ActionEventSchema.parse(intent.payload);
      await Promise.race([
        this.achievements.dispatchEvent(event, intent.id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Achievement delivery timed out after ${timeoutMs} ms`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
      await this.prisma.achievementDispatchIntent.updateMany({
        where: { id: intent.id, deliveredAt: null },
        data: {
          deliveredAt: new Date(),
          attempts: { increment: 1 },
          error: null,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.achievementDispatchIntent.updateMany({
        where: { id: intent.id, deliveredAt: null },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
          error: message,
        },
      });
      this.logger.warn(
        `Achievement intent ${intent.id} remains pending: ${message}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
