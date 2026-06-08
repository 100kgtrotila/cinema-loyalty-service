import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';
import type { Prisma } from 'src/generated/prisma/client';
import {
  ACHIEVEMENT_CRITERIA_OPERATOR,
  DEFAULT_SUM_VALUE_FIELD,
} from '../constants/achievement-criteria.constants';
import type {
  AchievementCriteria,
  RawAchievementCriteria,
} from '../interfaces/achievement-criteria.interface';
import {
  AchievementCriteriaSchema,
  RawAchievementCriteriaSchema,
} from '../schemas/achievement-criteria.schemas';

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

  return normalizeCriteria(result.data);
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

  const criteria: RawAchievementCriteria = normalizeCriteria(result.data);

  return {
    field: criteria.field,
    operator: criteria.operator,
    target: criteria.target,
    ...(criteria.valueField ? { valueField: criteria.valueField } : {}),
  };
}

function normalizeCriteria(criteria: AchievementCriteria): AchievementCriteria {
  if (criteria.operator !== ACHIEVEMENT_CRITERIA_OPERATOR.SUM) {
    return {
      field: criteria.field,
      operator: criteria.operator,
      target: criteria.target,
    };
  }

  return {
    field: criteria.field,
    operator: criteria.operator,
    target: criteria.target,
    valueField: criteria.valueField ?? DEFAULT_SUM_VALUE_FIELD,
  };
}
