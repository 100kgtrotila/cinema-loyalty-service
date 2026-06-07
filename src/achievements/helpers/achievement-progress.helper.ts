import { ACHIEVEMENT_CRITERIA_OPERATOR } from '../constants/achievement-criteria.constants';
import type { AchievementCriteria } from '../interfaces/achievement-criteria.interface';
import type { ActionEvent } from '../interfaces/action-event.interface';

export interface AchievementProgressIncrement {
  incrementBy: number;
  shouldProcess: boolean;
}

export function calculateAchievementProgressIncrement(
  criteria: AchievementCriteria,
  event: ActionEvent,
): AchievementProgressIncrement {
  if (criteria.operator !== ACHIEVEMENT_CRITERIA_OPERATOR.SUM) {
    return { incrementBy: 1, shouldProcess: true };
  }

  const raw = event.metadata?.[criteria.field];
  const value = typeof raw === 'number' ? raw : Number(raw ?? 0);

  if (value <= 0) {
    return { incrementBy: 0, shouldProcess: false };
  }

  return { incrementBy: Math.round(value), shouldProcess: true };
}
