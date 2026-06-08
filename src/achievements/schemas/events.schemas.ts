import { z } from 'zod';
import { ACHIEVEMENT_ACTIONS } from '../enums/achievement-action.enum';

export const ActionEventSchema = z.object({
  eventId: z.string().trim().min(1).max(91),
  userId: z.uuid(),
  actionType: z.enum(ACHIEVEMENT_ACTIONS),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
