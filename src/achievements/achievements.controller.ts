import { Controller, Get, UseGuards } from '@nestjs/common';
import { AchievementsService } from './achievements.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('loyalty/achievements')
export class AchievementsController {
  constructor(private readonly achievementsService: AchievementsService) {}

  @Get('available')
  async getAvailable() {
    return this.achievementsService.getAvailableAchievements();
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  async getMyAchievements(@CurrentUser('userId') userId: string) {
    return this.achievementsService.getUserProgress(userId);
  }
}
