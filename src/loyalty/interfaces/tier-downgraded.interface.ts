import { Tier } from 'src/generated/prisma/enums';

export interface TierDowngradedPayload {
  userId: string;
  oldTier: Tier;
  newTier: Tier;
}
