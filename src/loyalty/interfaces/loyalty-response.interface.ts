export enum GrpcTier {
  TIER_UNSPECIFIED = 0,
  TIER_BRONZE = 1,
  TIER_SILVER = 2,
  TIER_GOLD = 3,
}

export interface GetBalanceResponse {
  balance: number;
  lifetimePoints: number;
  yearPoints: number;
  tier: GrpcTier;
}

export interface GetFullProfileResponse {
  userId: string;
  tier: GrpcTier;
  balance: number;
  lifetimePoints: number;
  yearPoints: number;
  yearVisits: number;
  tierExpiresAt: string;
  balanceExpiresAt: string;
  isBirthdayWeek: boolean;
  goldUpgradeAvailable: boolean;
}

export interface DeductPointsResponse {
  success: boolean;
  balanceAfter: number;
  errorMessage?: string;
}

export interface UseGoldUpgradeResponse {
  success: boolean;
  errorMessage?: string;
}

export interface RefundPointsResponse {
  success: boolean;
  balanceAfter: number;
  errorMessage?: string;
}

export interface CalculateDiscountResponse {
  isAllowed: boolean;
  pointsToDeduct: number;
  amountToPay: number;
}
