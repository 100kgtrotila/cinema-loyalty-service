import {
  GrpcRequestPipe,
  userRequestSchema,
  achievementIdSchema,
} from '../common/grpc-request.pipe';
import { GrpcExceptionFilter } from '../common/grpc-exception.filter';
import { Controller, UseGuards, UseFilters } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { AdminAchievementsService } from './admin-achievements.service';
import { AchievementsService } from './achievements.service';
import type {
  CreateAchievementRequest,
  UpdateAchievementRequest,
  DeleteAchievementRequest,
  GetAdminAchievementsRequest,
  GetUserAchievementsRequest,
} from './interfaces/achievements-request.interface';
import { GrpcApiKeyGuard } from 'src/guards/grpc-api-key.guard';

@Controller()
@UseGuards(GrpcApiKeyGuard)
@UseFilters(GrpcExceptionFilter)
export class AchievementsController {
  constructor(
    private readonly adminService: AdminAchievementsService,
    private readonly userService: AchievementsService,
  ) {}

  @GrpcMethod('AchievementsService', 'CreateAchievement')
  async createAchievement(data: CreateAchievementRequest) {
    return this.adminService.createAchievementGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'UpdateAchievement')
  async updateAchievement(
    @Payload(new GrpcRequestPipe(achievementIdSchema))
    data: UpdateAchievementRequest,
  ) {
    return this.adminService.updateAchievementGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'DeleteAchievement')
  async deleteAchievement(
    @Payload(new GrpcRequestPipe(achievementIdSchema))
    data: DeleteAchievementRequest,
  ) {
    return this.adminService.deleteAchievementGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'GetAdminAchievements')
  async getAdminAchievements(data: GetAdminAchievementsRequest) {
    return this.adminService.getAdminAchievementsGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'GetUserAchievements')
  async getUserAchievements(
    @Payload(new GrpcRequestPipe(userRequestSchema))
    data: GetUserAchievementsRequest,
  ) {
    return this.userService.getUserAchievementsGrpc(data);
  }
}
