export interface AchievementCriteria {
  field: string;
  operator: string;
  target: number;
  [key: string]: unknown;
}
