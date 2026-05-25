import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';
import { Prisma } from 'src/generated/prisma/client';
import { z } from 'zod';

const AchievementCriteriaSchema = z.object({
  field: z.string().min(1),
  operator: z.string().min(1),
  target: z.number(),
});

export type AchievementCriteria = z.infer<typeof AchievementCriteriaSchema>;

export function validateAndParseCriteriaJson(
  criteriaJson: string,
): Prisma.InputJsonValue {
  let parsed: unknown;

  try {
    parsed = JSON.parse(criteriaJson);
  } catch {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: 'criteriaJson is not valid JSON',
    });
  }

  const result = AchievementCriteriaSchema.safeParse(parsed);

  if (!result.success) {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: `Invalid criteria: ${result.error.message}`,
    });
  }

  return result.data;
}
