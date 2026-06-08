import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RpcException } from '@nestjs/microservices';
import { GrpcStatus } from 'src/common/grpc-status';

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
  normalizeAchievementInput,
  normalizeAdminAchievementsPagination,
} from './validators/admin-achievement-input.validator';

@Injectable()
export class AdminAchievementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mapper: AchievementMapper,
  ) {}

  async createAchievementGrpc(
    req: CreateAchievementRequest,
  ): Promise<CreateAchievementResponse> {
    const input = normalizeAchievementInput(req);

    const existing = await this.prisma.achievement.findUnique({
      where: { code: input.code },
      select: { id: true },
    });
    if (existing) {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: `Achievement with code '${input.code}' already exists`,
      });
    }

    const created = await this.prisma.achievement.create({
      data: input,
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

    const input = normalizeAchievementInput(req);

    if (input.code !== found.code) {
      const sameCode = await this.prisma.achievement.findUnique({
        where: { code: input.code },
        select: { id: true },
      });
      if (sameCode) {
        throw new RpcException({
          code: GrpcStatus.ALREADY_EXISTS,
          message: `Achievement with code '${input.code}' already exists`,
        });
      }
    }

    const updated = await this.prisma.achievement.update({
      where: { id: req.id },
      data: input,
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
    const { limit, offset } = normalizeAdminAchievementsPagination(req);

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
