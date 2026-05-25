import { z } from 'zod';

export const ActionEventSchema = z.object({
  eventId: z.uuid(),
  userId: z.uuid(),
  actionType: z.string(),
});

export const CriteriaSchema = z.object({
  field: z.string(),
  operator: z.enum(['gte', 'sum']),
  target: z.number(),
});
