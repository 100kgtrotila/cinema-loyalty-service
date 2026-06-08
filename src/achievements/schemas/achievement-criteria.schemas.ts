import { z } from 'zod';
import {
  ACHIEVEMENT_CRITERIA_OPERATORS,
  MAX_ACHIEVEMENT_TARGET,
} from '../constants/achievement-criteria.constants';
import { ACHIEVEMENT_ACTIONS } from '../enums/achievement-action.enum';

const AchievementCriteriaShape = {
  field: z.enum(ACHIEVEMENT_ACTIONS),
  operator: z.enum(ACHIEVEMENT_CRITERIA_OPERATORS),
  target: z.number().int().positive().max(MAX_ACHIEVEMENT_TARGET),
  valueField: z.string().trim().min(1).max(64).optional(),
} as const;

export const RawAchievementCriteriaSchema = z.object({
  ...AchievementCriteriaShape,
});

export const AchievementCriteriaSchema = z.object({
  ...AchievementCriteriaShape,
});
