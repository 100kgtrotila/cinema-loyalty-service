import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from 'eventemitter2';
import { PrismaService } from 'src/prisma/prisma.service';
import { RawOutboxEvent } from './interfaces/raw-outbox-event.interface';
import { CRON_SCHEDULES } from './constants/loyalty.constants';

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly MAX_ATTEMPTS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
  ) {}

  @Cron(CRON_SCHEDULES.EVERY_5_SECONDS)
  async publishPendingEvents(): Promise<void> {
    const events = await this.prisma.$queryRaw<RawOutboxEvent[]>`
      UPDATE "outbox_events"
      SET
        status     = 'PROCESSING'::"OutboxEventStatus",
        updated_at = NOW()
      WHERE id IN (
        SELECT id
        FROM "outbox_events"
        WHERE
          status   = 'PENDING'::"OutboxEventStatus"
          AND attempts < ${this.MAX_ATTEMPTS}
        ORDER BY created_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `;

    if (!events || events.length === 0) return;

    await Promise.allSettled(events.map((event) => this.processEvent(event)));
  }

  private async processEvent(event: RawOutboxEvent): Promise<void> {
    try {
      this.emitter.emit(event.type, event.payload);

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'COMPLETED',
          publishedAt: new Date(),
          attempts: { increment: 1 },
          error: null,
        },
      });
    } catch (error: unknown) {
      const attempts = event.attempts + 1;
      const isFinal = attempts >= this.MAX_ATTEMPTS;

      const errorMessage =
        error instanceof Error
          ? `${error.message}\n${error.stack}`
          : String(error);

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: isFinal ? 'FAILED' : 'PENDING',
          attempts: { increment: 1 },
          error: errorMessage,
        },
      });

      this.logger.error(
        `Outbox event ${event.id} (${event.type}) failed. ` +
          `Attempt ${attempts}/${this.MAX_ATTEMPTS}. ` +
          `${isFinal ? 'FINAL FAILURE' : 'Will retry'}. ` +
          `Error: ${errorMessage}`,
      );
    }
  }
}
