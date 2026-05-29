import { z } from 'zod';
import { AchievementCriteriaSchema } from '../validators/achievement-criteria.validator';

export const ActionEventSchema = z.object({
  eventId: z.uuid(),
  userId: z.uuid(),
  actionType: z.string(),
});

export const CriteriaSchema = AchievementCriteriaSchema;
