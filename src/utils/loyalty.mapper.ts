import { Tier } from 'src/generated/prisma/enums';
import { GrpcTier } from 'src/loyalty/interfaces/loyalty-response.interface';

export class LoyaltyMapper {
  static toGrpcTier(tier: Tier): GrpcTier {
    switch (tier) {
      case Tier.BRONZE:
        return GrpcTier.TIER_BRONZE;
      case Tier.SILVER:
        return GrpcTier.TIER_SILVER;
      case Tier.GOLD:
        return GrpcTier.TIER_GOLD;
      default:
        return GrpcTier.TIER_UNSPECIFIED;
    }
  }
}
