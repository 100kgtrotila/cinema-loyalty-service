import type { ReplayConfiguration } from '../../config/app.config';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfirmChannel } from 'amqplib';
import { deserialize } from 'node:v8';
import { z } from 'zod';
import { PrismaService } from 'src/prisma/prisma.service';
import { inboundDeliveryId } from './rmq-delivery.service';
import { publishConfirmed } from './confirmed-rmq-publish';

const PropertiesSchema = z.object({
  contentType: z.string().optional(),
  contentEncoding: z.string().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  deliveryMode: z.number().optional(),
  priority: z.number().optional(),
  correlationId: z.string().optional(),
  replyTo: z.string().optional(),
  messageId: z.string().optional(),
  timestamp: z.number().optional(),
  type: z.string().optional(),
  appId: z.string().optional(),
  userId: z.string().optional(),
  expiration: z.string().optional(),
});

@Injectable()
export class QuarantineReplayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<ReplayConfiguration>,
  ) {}

  async replay(
    id: string,
    replayId: string,
    channel: ConfirmChannel,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id) || !z.uuid().safeParse(replayId).success)
      throw new Error('INVALID_REPLAY_ID');
    const record = await this.prisma.inboundDelivery.findUniqueOrThrow({
      where: { id },
    });
    const queue = this.config.getOrThrow('app.rmqQueue', { infer: true });
    if (
      record.sourceQueue !== queue ||
      !record.originalBody ||
      !record.originalProperties
    )
      throw new Error('REPLAY_SOURCE_MISMATCH');
    const body = Buffer.from(record.originalBody);
    if (inboundDeliveryId(queue, body) !== id)
      throw new Error('REPLAY_BODY_MISMATCH');
    if ((await channel.checkQueue(queue)).consumerCount !== 0)
      throw new Error('STOP_ALL_SOURCE_CONSUMERS_BEFORE_REPLAY');

    // Only properties previously serialized by this service are deserialized.
    // Run the tool with the deployed Node runtime. No caller-provided file is loaded.
    const decoded: unknown = deserialize(
      Buffer.from(record.originalProperties),
    );
    const { userId, expiration, ...properties } =
      PropertiesSchema.parse(decoded);
    const changed = await this.prisma.$executeRaw`
      UPDATE inbound_deliveries
      SET replay_id = ${replayId}::uuid, replay_count = replay_count + 1,
        attempts = 0, quarantine_required = FALSE, quarantined_at = NULL, completed_at = NULL,
        error_code = NULL, lease_token = NULL, lease_expires_at = NULL,
        next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${id} AND quarantined_at IS NOT NULL AND replay_id IS DISTINCT FROM ${replayId}::uuid
        AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
    `;
    if (changed !== 1 && record.replayId !== replayId)
      throw new Error('DELIVERY_IS_NOT_QUARANTINED');
    if ((await channel.checkQueue(queue)).consumerCount !== 0)
      throw new Error('SOURCE_CONSUMER_STARTED_DURING_REPLAY');
    // Keep validated-user-id as metadata rather than impersonating its original
    // broker user. Do not expire a financial replay before it can be processed.
    const headers: Record<string, unknown> = { ...properties.headers };
    if (userId !== undefined) headers['x-loyalty-original-user-id'] = userId;
    if (expiration !== undefined)
      headers['x-loyalty-original-expiration'] = expiration;
    await publishConfirmed(
      channel,
      queue,
      body,
      { ...properties, headers },
      10000,
    );
    // Keep the original bytes after publishing. On timeout/ACK loss, rerun with
    // the SAME replayId: it republishes without resetting a budget a second time.
  }
}
