import type { AchievementCriteriaOperator } from '../constants/achievement-criteria.constants';

export interface RawAchievementCriteria {
  field: string;
  operator: string;
  target: number;
}

export interface AchievementCriteria extends RawAchievementCriteria {
  operator: AchievementCriteriaOperator;
}
