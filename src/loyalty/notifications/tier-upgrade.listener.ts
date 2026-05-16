import { Injectable, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClientProxy } from '@nestjs/microservices';
import { TierUpgradeEvent } from '../events/tier-upgraded.event';

@Injectable()
export class TierUpgradeListener {
  private readonly logger = new Logger(TierUpgradeListener.name);

  constructor(
    @Inject('LOYALTY_PUBLISHER')
    private readonly client: ClientProxy,
  ) {}

  @OnEvent('loyalty.tier_upgraded')
  async handle(payload: TierUpgradeEvent): Promise<void> {
    this.logger.log(
      `Publishing tier upgrade for user ${payload.userId}: ${payload.oldTier} → ${payload.newTier}`,
    );

    this.client
      .emit('loyalty.tier_upgraded', {
        userId: payload.userId,
        oldTier: payload.oldTier,
        newTier: payload.newTier,
        upgradedAt: new Date().toISOString(),
      })
      .subscribe({
        error: (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error(`Failed to publish TierUpgradedEvent: ${msg}`);
        },
      });
  }
}
