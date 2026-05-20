import { Injectable, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClientProxy } from '@nestjs/microservices';
import { TierUpgradeEvent } from '../events/tier-upgraded.event';
import { lastValueFrom } from 'rxjs';
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

  @OnEvent(RABBITMQ_EVENTS.TIER_UPGRADED)
  async handle(payload: TierUpgradeEvent): Promise<void> {
    this.logger.log(
      `Publishing tier upgrade for user ${payload.userId}: ${payload.oldTier} → ${payload.newTier}`,
    );

    try {
      await lastValueFrom(
        this.client.emit(RABBITMQ_EVENTS.TIER_UPGRADED, {
          userId: payload.userId,
          oldTier: payload.oldTier,
          newTier: payload.newTier,
          upgradedAt: new Date().toISOString(),
        }),
      );
      this.logger.log(
        `Successfully published event for user ${payload.userId}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to publish TierUpgradedEvent: ${msg}`);
    }
  }
}
