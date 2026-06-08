import type { AchievementAction } from '../enums/achievement-action.enum';
import type { AchievementCriteriaOperator } from '../types/achievement-criteria-operator.type';

export interface RawAchievementCriteria {
  field: AchievementAction;
  operator: string;
  target: number;
  valueField?: string;
}

export interface AchievementCriteria extends RawAchievementCriteria {
  operator: AchievementCriteriaOperator;
}
