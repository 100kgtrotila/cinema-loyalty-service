export enum OutboxEventType {
  TIER_UPGRADED = 'loyalty.tier_upgraded',
  TIER_DOWNGRADED = 'loyalty.tier_downgraded',
  POINTS_EXPIRED = 'loyalty.points_expired',
  POINTS_REFUNDED = 'loyalty.points_refunded',
  POINTS_EARNED = 'loyalty.points_earned',
  POINTS_DEDUCTED = 'loyalty.points_deducted',
}

export enum AggregateType {
  LOYALTY_PROFILE = 'LoyaltyProfile',
  POINTS_TRANSACTION = 'PointsTransaction',
  PROCESSED_EVENT = 'ProcessedEvent',
}

export enum EventPatternType {
  TICKET_PURCHASED = 'TicketPurchased',
}
