import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';
import { Prisma } from 'src/generated/prisma/client';
import { z } from 'zod';
import { ACHIEVEMENT_CRITERIA_OPERATORS } from '../constants/achievement-criteria.constants';
import type {
  AchievementCriteria,
  RawAchievementCriteria,
} from '../interfaces/achievement-criteria.interface';

const AchievementCriteriaShape = {
  field: z.string(),
  operator: z.string(),
  target: z.number(),
} as const;

export const RawAchievementCriteriaSchema = z.object({
  ...AchievementCriteriaShape,
  field: AchievementCriteriaShape.field.min(1),
  operator: AchievementCriteriaShape.operator.min(1),
});

export const AchievementCriteriaSchema = z.object({
  ...AchievementCriteriaShape,
  operator: z.enum(ACHIEVEMENT_CRITERIA_OPERATORS),
});

export function parseAchievementCriteria(
  criteria: unknown,
): AchievementCriteria {
  const result = AchievementCriteriaSchema.safeParse(criteria);

  if (!result.success) {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: `Invalid criteria: ${result.error.message}`,
    });
  }

  return result.data;
}

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

  const result = RawAchievementCriteriaSchema.safeParse(parsed);

  if (!result.success) {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: `Invalid criteria: ${result.error.message}`,
    });
  }

  const criteria: RawAchievementCriteria = result.data;

  return {
    field: criteria.field,
    operator: criteria.operator,
    target: criteria.target,
  };
}
