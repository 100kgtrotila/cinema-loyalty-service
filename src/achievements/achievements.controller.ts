import { Controller, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { GrpcApiKeyGuard } from 'src/guards/grpc-api-key.guard';
import { AchievementsService } from './achievements.service';
import { AdminAchievementsService } from './admin-achievements.service';
import type {
  CreateAchievementRequest,
  UpdateAchievementRequest,
  DeleteAchievementRequest,
  GetAdminAchievementsRequest,
  GetUserAchievementsRequest,
} from './interfaces/achievements-request.interface';

@Controller()
@UseGuards(GrpcApiKeyGuard)
export class AchievementsController {
  constructor(
    private readonly achievementsService: AchievementsService,
    private readonly adminAchievementsService: AdminAchievementsService,
  ) {}

  @GrpcMethod('AchievementsService', 'CreateAchievement')
  createAchievement(data: CreateAchievementRequest) {
    return this.adminAchievementsService.createAchievementGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'UpdateAchievement')
  updateAchievement(data: UpdateAchievementRequest) {
    return this.adminAchievementsService.updateAchievementGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'DeleteAchievement')
  deleteAchievement(data: DeleteAchievementRequest) {
    return this.adminAchievementsService.deleteAchievementGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'GetAdminAchievements')
  getAdminAchievements(data: GetAdminAchievementsRequest) {
    return this.adminAchievementsService.getAdminAchievementsGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'GetUserAchievements')
  getUserAchievements(data: GetUserAchievementsRequest) {
    return this.achievementsService.getUserAchievementsGrpc(data);
  }
}
