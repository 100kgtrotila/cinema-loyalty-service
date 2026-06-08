import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';
import {
  ACHIEVEMENT_CODE_MAX_LENGTH,
  ACHIEVEMENT_DESCRIPTION_MAX_LENGTH,
  ACHIEVEMENT_ICON_MAX_LENGTH,
  ACHIEVEMENT_MAX_REWARD_POINTS,
  ACHIEVEMENT_NAME_MAX_LENGTH,
  ACHIEVEMENT_SORT_ORDER_MAX,
  ACHIEVEMENT_SORT_ORDER_MIN,
  ADMIN_ACHIEVEMENTS_LIMIT_MAX,
  ADMIN_ACHIEVEMENTS_LIMIT_MIN,
  ADMIN_ACHIEVEMENTS_OFFSET_MAX,
  ADMIN_ACHIEVEMENTS_OFFSET_MIN,
} from '../constants/admin-achievement-input.constants';
import {
  GrpcToCategory,
  GrpcToRarity,
  GrpcToStrategy,
} from '../enums/achievement-maps.enum';
import type { GetAdminAchievementsRequest } from '../interfaces/achievements-request.interface';
import type { AdminAchievementsPagination } from '../interfaces/admin-achievements-pagination.interface';
import type { AchievementMutationRequest } from '../types/admin-achievement-input.type';
import { validateAndParseCriteriaJson } from './achievement-criteria.validator';

export function normalizeAchievementInput(req: AchievementMutationRequest) {
  return {
    code: requiredString(req.code, 'code', ACHIEVEMENT_CODE_MAX_LENGTH),
    name: requiredString(req.name, 'name', ACHIEVEMENT_NAME_MAX_LENGTH),
    description: requiredString(
      req.description,
      'description',
      ACHIEVEMENT_DESCRIPTION_MAX_LENGTH,
    ),
    secretHint: optionalString(req.secretHint),
    isSecret: Boolean(req.isSecret),
    icon: requiredString(req.icon, 'icon', ACHIEVEMENT_ICON_MAX_LENGTH),
    category: mapToPrisma(GrpcToCategory, req.category, 'category'),
    rarity: mapToPrisma(GrpcToRarity, req.rarity, 'rarity'),
    strategy: mapToPrisma(GrpcToStrategy, req.strategy, 'strategy'),
    criteria: validateAndParseCriteriaJson(req.criteriaJson),
    rewardPoints: intInRange(
      req.rewardPoints,
      'rewardPoints',
      0,
      ACHIEVEMENT_MAX_REWARD_POINTS,
    ),
    sortOrder: intInRange(
      req.sortOrder,
      'sortOrder',
      ACHIEVEMENT_SORT_ORDER_MIN,
      ACHIEVEMENT_SORT_ORDER_MAX,
    ),
    isActive: Boolean(req.isActive),
  };
}

export function normalizeAdminAchievementsPagination(
  req: GetAdminAchievementsRequest,
): AdminAchievementsPagination {
  return {
    limit: clampInt(
      req.limit,
      ADMIN_ACHIEVEMENTS_LIMIT_MIN,
      ADMIN_ACHIEVEMENTS_LIMIT_MAX,
    ),
    offset: clampInt(
      req.offset,
      ADMIN_ACHIEVEMENTS_OFFSET_MIN,
      ADMIN_ACHIEVEMENTS_OFFSET_MAX,
    ),
  };
}

function mapToPrisma<T>(
  map: Record<number, T>,
  value: number,
  field: string,
): T {
  const mapped = map[value];
  if (!mapped) {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: `Invalid ${field}`,
    });
  }
  return mapped;
}

function clampInt(v: number | undefined, min: number, max: number): number {
  if (v === undefined || v === null) return min;
  const n = Number.isFinite(v) ? Math.trunc(v) : min;
  return Math.min(Math.max(n, min), max);
}

function requiredString(value: string, field: string, max: number): string {
  const normalized = value?.trim();

  if (!normalized || normalized.length > max) {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: `${field} must be between 1 and ${max} characters`,
    });
  }

  return normalized;
}

function optionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function intInRange(
  value: number | undefined,
  field: string,
  min: number,
  max: number,
): number {
  const normalized = value ?? 0;

  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: `${field} must be an integer between ${min} and ${max}`,
    });
  }

  return normalized;
}
