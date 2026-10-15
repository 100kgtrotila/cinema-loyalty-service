import { Injectable, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClientProxy, RmqRecordBuilder } from '@nestjs/microservices';
import { TierUpgradeEvent } from '../events/tier-upgraded.event';
import { lastValueFrom } from 'rxjs';
import type { OutboxDeliveryContext } from '../interfaces/outbox-delivery-context.interface';
import {
  INJECTION_TOKENS,
  RABBITMQ_EVENTS,
} from '../constants/loyalty.constants';

@Injectable()
export class TierUpgradeListener {
  private readonly logger = new Logger(TierUpgradeListener.name);

  constructor(
    @Inject(INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT)
    private readonly client: ClientProxy,
  ) {}

  @OnEvent(RABBITMQ_EVENTS.TIER_UPGRADED, { suppressErrors: false })
  async handle(
    payload: TierUpgradeEvent,
    context: OutboxDeliveryContext,
  ): Promise<void> {
    this.logger.log(
      `Publishing tier upgrade for user ${payload.userId}: ${payload.oldTier} → ${payload.newTier}`,
    );

    try {
      await lastValueFrom(
        this.client.emit(
          RABBITMQ_EVENTS.TIER_UPGRADED,
          new RmqRecordBuilder({
            userId: payload.userId,
            oldTier: payload.oldTier,
            newTier: payload.newTier,
            upgradedAt: context.occurredAt.toISOString(),
          })
            .setOptions({ messageId: context.eventId, persistent: true })
            .build(),
        ),
      );
      this.logger.log(
        `Successfully published event for user ${payload.userId}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to publish TierUpgradedEvent: ${msg}`);
      throw err;
    }
  }
}
