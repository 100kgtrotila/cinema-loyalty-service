export interface GetBalanceRequest {
  userId: string;
}
export interface GetFullProfileRequest {
  userId: string;
}
export interface DeductPointsRequest {
  userId: string;
  amount: number;
  orderId: string;
  idempotencyKey: string;
}
export interface UseGoldUpgradeRequest {
  userId: string;
  orderId: string;
}

export interface CalculateDiscountRequest {
  userId: string;
  orderAmount: number;
}
export interface RefundPointsRequest {
  userId: string;
  amount: number;
  orderId: string;
  idempotencyKey: string;
}
