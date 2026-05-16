import { Tier } from 'src/generated/prisma/enums';

export class TierUpgradeEvent {
  constructor(
    public readonly userId: string,
    public readonly oldTier: Tier,
    public readonly newTier: Tier,
  ) {}
}
