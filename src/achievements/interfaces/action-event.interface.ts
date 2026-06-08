import type { AchievementAction } from '../enums/achievement-action.enum';

export interface ActionEvent {
  eventId: string;
  userId: string;
  actionType: AchievementAction;
  metadata?: Record<string, unknown>;
}
