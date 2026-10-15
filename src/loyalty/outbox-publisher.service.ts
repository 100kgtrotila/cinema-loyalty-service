import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from 'eventemitter2';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { RawOutboxEvent } from './interfaces/raw-outbox-event.interface';
import { CRON_SCHEDULES } from './constants/loyalty.constants';
import { OutboxDeliveryContext } from './interfaces/outbox-delivery-context.interface';

const BATCH_SIZE = 50;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private publishing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CRON_SCHEDULES.EVERY_5_SECONDS, { waitForCompletion: true })
  async publishPendingEvents(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try {
      await this.recoverExpiredClaims();
      await this.failExhaustedPending();
      const concurrency = this.configService.getOrThrow<number>(
        'app.outboxPublishConcurrency',
      );
      for (let claimed = 0; claimed < BATCH_SIZE; ) {
        // Claim only an immediately runnable wave: no leased rows wait in a
        // local queue while earlier publications use up their lease.
        const events = await this.claimEvents(
          Math.min(concurrency, BATCH_SIZE - claimed),
        );
        if (events.length === 0) break;
        claimed += events.length;
        const results = await Promise.allSettled(
          events.map((event) => this.processEvent(event)),
        );
        for (const result of results) {
          if (result.status === 'rejected') {
            const error: unknown = result.reason;
            this.logger.error(
              `Could not record outbox result; lease recovery will retry: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  private async recoverExpiredClaims(): Promise<void> {
    // Legacy PROCESSING rows with no token/lease require explicit operator
    // reconciliation after all old publishers have stopped. Never auto-replay.
    await this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = CASE WHEN attempts >= max_attempts
            THEN 'FAILED'::"OutboxEventStatus" ELSE 'PENDING'::"OutboxEventStatus" END,
          next_attempt_at = clock_timestamp() +
            LEAST(${RETRY_MAX_MS}, ${RETRY_BASE_MS} * power(2, LEAST(GREATEST(attempts - 1, 0), 4))) * interval '1 millisecond',
          lease_token = NULL, lease_expires_at = NULL,
          error = CASE WHEN attempts >= max_attempts THEN 'Outbox attempts exhausted (including expired claims)'
            ELSE 'Outbox claim lease expired; retry scheduled' END,
          updated_at = clock_timestamp()
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PROCESSING'::"OutboxEventStatus"
          AND lease_token IS NOT NULL AND lease_expires_at <= statement_timestamp()
        ORDER BY created_at, id LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      )
    `;
  }

  private async failExhaustedPending(): Promise<void> {
    // The current writer never creates exhausted PENDING rows. Older publishers
    // used a fixed attempt budget, so existing rows still need bounded cleanup.
    await this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'FAILED'::"OutboxEventStatus",
          next_attempt_at = clock_timestamp() +
            LEAST(${RETRY_MAX_MS}, ${RETRY_BASE_MS} * power(2, LEAST(GREATEST(attempts - 1, 0), 4))) * interval '1 millisecond',
          lease_token = NULL, lease_expires_at = NULL,
          error = 'Outbox attempts exhausted (including expired claims)',
          updated_at = clock_timestamp()
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PENDING'::"OutboxEventStatus" AND attempts >= max_attempts
        ORDER BY created_at, id LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      )
    `;
  }

  private async claimEvents(limit: number): Promise<RawOutboxEvent[]> {
    const leaseMs = this.configService.getOrThrow<number>('app.outboxLeaseMs');
    return this.prisma.$queryRaw<RawOutboxEvent[]>`
      UPDATE outbox_events
      SET status = 'PROCESSING'::"OutboxEventStatus",
          attempts = attempts + 1,
          lease_token = gen_random_uuid(),
          lease_expires_at = clock_timestamp() + ${leaseMs} * interval '1 millisecond',
          updated_at = clock_timestamp()
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PENDING'::"OutboxEventStatus"
          AND attempts < max_attempts AND next_attempt_at <= statement_timestamp()
        ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;
  }

  private async processEvent(event: RawOutboxEvent): Promise<void> {
    const timeoutMs = this.configService.getOrThrow<number>(
      'app.outboxPublishTimeoutMs',
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const context: OutboxDeliveryContext = {
        eventId: event.id,
        occurredAt: event.created_at,
      };
      // Timeout bounds this attempt's wait, not the underlying network effect.
      // A late send can still be delivered; consumers must deduplicate.
      const results = await Promise.race([
        this.emitter.emitAsync(event.type, event.payload, context),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(`Outbox publication timed out after ${timeoutMs} ms`),
              ),
            timeoutMs,
          );
        }),
      ]);
      if (results.length === 0)
        throw new Error(`No outbox listener registered for ${event.type}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const delayMs = Math.min(
        RETRY_MAX_MS,
        RETRY_BASE_MS * 2 ** Math.min(event.attempts - 1, 4),
      );
      const updated = await this.prisma.$executeRaw`
        UPDATE outbox_events
        SET status = CASE WHEN attempts >= max_attempts
              THEN 'FAILED'::"OutboxEventStatus" ELSE 'PENDING'::"OutboxEventStatus" END,
            next_attempt_at = clock_timestamp() + ${delayMs} * interval '1 millisecond',
            error = ${message}, lease_token = NULL, lease_expires_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = ${event.id}::uuid AND status = 'PROCESSING'::"OutboxEventStatus"
          AND lease_token = ${event.lease_token}::uuid
          AND lease_expires_at > clock_timestamp()
      `;
      if (updated === 0) this.logLostOwnership(event);
      else
        this.logger.warn(
          `Outbox ${event.id} failed at attempt ${event.attempts}/${event.max_attempts}: ${message}`,
        );
      return;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    // A DB completion failure leaves PROCESSING intact for lease recovery.
    // Do not turn a successful broker confirmation into a new failure update.
    const updated = await this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'COMPLETED'::"OutboxEventStatus", published_at = clock_timestamp(),
          error = NULL, lease_token = NULL, lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE id = ${event.id}::uuid AND status = 'PROCESSING'::"OutboxEventStatus"
        AND lease_token = ${event.lease_token}::uuid
        AND lease_expires_at > clock_timestamp()
    `;
    if (updated === 0) this.logLostOwnership(event);
  }

  private logLostOwnership(event: RawOutboxEvent): void {
    this.logger.warn(
      `Ignored outbox result after ownership loss: ${event.id}, claim ${event.lease_token}`,
    );
  }
}
