export interface ActionEvent {
  eventId: string;
  userId: string;
  actionType: string;
  metadata?: Record<string, unknown>;
}
