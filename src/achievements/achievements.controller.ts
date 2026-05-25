import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { AdminAchievementsService } from './admin-achievements.service';
import { AchievementsService } from './achievements.service';
import type {
  CreateAchievementRequest,
  UpdateAchievementRequest,
  DeleteAchievementRequest,
  GetAdminAchievementsRequest,
  GetUserAchievementsRequest,
} from './interfaces/achievements-request.interface';

@Controller()
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
  async updateAchievement(data: UpdateAchievementRequest) {
    return this.adminService.updateAchievementGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'DeleteAchievement')
  async deleteAchievement(data: DeleteAchievementRequest) {
    return this.adminService.deleteAchievementGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'GetAdminAchievements')
  async getAdminAchievements(data: GetAdminAchievementsRequest) {
    return this.adminService.getAdminAchievementsGrpc(data);
  }

  @GrpcMethod('AchievementsService', 'GetUserAchievements')
  async getUserAchievements(data: GetUserAchievementsRequest) {
    return this.userService.getUserAchievementsGrpc(data);
  }
}
