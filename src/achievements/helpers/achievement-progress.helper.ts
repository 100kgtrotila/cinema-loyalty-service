import {
  ACHIEVEMENT_CRITERIA_OPERATOR,
  DEFAULT_SUM_VALUE_FIELD,
} from '../constants/achievement-criteria.constants';
import type { AchievementCriteria } from '../interfaces/achievement-criteria.interface';
import type { AchievementProgressIncrement } from '../interfaces/achievement-progress.interface';
import type { ActionEvent } from '../interfaces/action-event.interface';

export function calculateAchievementProgressIncrement(
  criteria: AchievementCriteria,
  event: ActionEvent,
): AchievementProgressIncrement {
  if (criteria.operator !== ACHIEVEMENT_CRITERIA_OPERATOR.SUM) {
    return { incrementBy: 1, shouldProcess: true };
  }

  const valueField = criteria.valueField ?? DEFAULT_SUM_VALUE_FIELD;
  const raw = event.metadata?.[valueField];
  const value = typeof raw === 'number' ? raw : Number(raw ?? 0);

  if (value <= 0) {
    return { incrementBy: 0, shouldProcess: false };
  }

  return { incrementBy: Math.round(value), shouldProcess: true };
}
