import { ACHIEVEMENT_CRITERIA_OPERATORS } from '../constants/achievement-criteria.constants';

export type AchievementCriteriaOperator =
  (typeof ACHIEVEMENT_CRITERIA_OPERATORS)[number];
