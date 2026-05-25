import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';

import { validateAndParseCriteriaJson } from './validators/achievement-criteria.validator';
import {
  CreateAchievementRequest,
  UpdateAchievementRequest,
  DeleteAchievementRequest,
  GetAdminAchievementsRequest,
} from './interfaces/achievements-request.interface';
import {
  CreateAchievementResponse,
  UpdateAchievementResponse,
  DeleteAchievementResponse,
  GetAdminAchievementsResponse,
} from './interfaces/achievements-response.interface';
import { AchievementMapper } from './mappers/achievement.mapper';
import {
  GrpcToCategory,
  GrpcToRarity,
  GrpcToStrategy,
} from './enums/achievement-maps.enum';

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

@Injectable()
export class AdminAchievementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mapper: AchievementMapper,
  ) {}

  async createAchievementGrpc(
    req: CreateAchievementRequest,
  ): Promise<CreateAchievementResponse> {
    const existing = await this.prisma.achievement.findUnique({
      where: { code: req.code },
      select: { id: true },
    });
    if (existing) {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: `Achievement with code '${req.code}' already exists`,
      });
    }

    const criteria = validateAndParseCriteriaJson(req.criteriaJson);

    const created = await this.prisma.achievement.create({
      data: {
        code: req.code,
        name: req.name,
        description: req.description,
        secretHint: req.secretHint ?? null,
        isSecret: req.isSecret,
        icon: req.icon,
        category: mapToPrisma(GrpcToCategory, req.category, 'category'),
        rarity: mapToPrisma(GrpcToRarity, req.rarity, 'rarity'),
        strategy: mapToPrisma(GrpcToStrategy, req.strategy, 'strategy'),
        criteria,
        rewardPoints: req.rewardPoints ?? 0,
        sortOrder: req.sortOrder ?? 0,
        isActive: req.isActive,
      },
    });

    return { achievement: this.mapper.toGrpc(created) };
  }

  async updateAchievementGrpc(
    req: UpdateAchievementRequest,
  ): Promise<UpdateAchievementResponse> {
    const found = await this.prisma.achievement.findUnique({
      where: { id: req.id },
    });
    if (!found) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `Achievement '${req.id}' not found`,
      });
    }

    if (req.code !== found.code) {
      const sameCode = await this.prisma.achievement.findUnique({
        where: { code: req.code },
        select: { id: true },
      });
      if (sameCode) {
        throw new RpcException({
          code: GrpcStatus.ALREADY_EXISTS,
          message: `Achievement with code '${req.code}' already exists`,
        });
      }
    }

    const criteria = validateAndParseCriteriaJson(req.criteriaJson);

    const updated = await this.prisma.achievement.update({
      where: { id: req.id },
      data: {
        code: req.code,
        name: req.name,
        description: req.description,
        secretHint: req.secretHint ?? null,
        isSecret: req.isSecret,
        icon: req.icon,
        category: mapToPrisma(GrpcToCategory, req.category, 'category'),
        rarity: mapToPrisma(GrpcToRarity, req.rarity, 'rarity'),
        strategy: mapToPrisma(GrpcToStrategy, req.strategy, 'strategy'),
        criteria,
        rewardPoints: req.rewardPoints ?? 0,
        sortOrder: req.sortOrder ?? 0,
        isActive: req.isActive,
      },
    });

    return { achievement: this.mapper.toGrpc(updated) };
  }

  async deleteAchievementGrpc(
    req: DeleteAchievementRequest,
  ): Promise<DeleteAchievementResponse> {
    const found = await this.prisma.achievement.findUnique({
      where: { id: req.id },
    });
    if (!found) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `Achievement '${req.id}' not found`,
      });
    }

    if (!found.isActive) {
      return { achievement: this.mapper.toGrpc(found) };
    }

    const updated = await this.prisma.achievement.update({
      where: { id: req.id },
      data: { isActive: false },
    });

    return { achievement: this.mapper.toGrpc(updated) };
  }

  async getAdminAchievementsGrpc(
    req: GetAdminAchievementsRequest,
  ): Promise<GetAdminAchievementsResponse> {
    const includeInactive = Boolean(req.includeInactive);
    const limit = clampInt(req.limit, 1, 200);
    const offset = clampInt(req.offset, 0, 1_000_000);

    const where = includeInactive ? {} : { isActive: true };

    const [total, achievements] = await this.prisma.$transaction([
      this.prisma.achievement.count({ where }),
      this.prisma.achievement.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      }),
    ]);

    return {
      total,
      achievements: achievements.map((a) => this.mapper.toGrpc(a)),
    };
  }
}
