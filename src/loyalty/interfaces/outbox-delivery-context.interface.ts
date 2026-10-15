export interface OutboxDeliveryContext {
  eventId: string;
  occurredAt: Date;
}
