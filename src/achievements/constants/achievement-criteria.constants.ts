export const ACHIEVEMENT_CRITERIA_OPERATOR = {
  GTE: 'gte',
  SUM: 'sum',
} as const;

export const ACHIEVEMENT_CRITERIA_OPERATORS = [
  ACHIEVEMENT_CRITERIA_OPERATOR.GTE,
  ACHIEVEMENT_CRITERIA_OPERATOR.SUM,
] as const;

export type AchievementCriteriaOperator =
  (typeof ACHIEVEMENT_CRITERIA_OPERATORS)[number];
