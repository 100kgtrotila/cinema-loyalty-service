import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { AchievementsService } from './achievements.service';
import { AdminAchievementsService } from './admin-achievements.service';
import { AchievementsProcessor } from './processors/achievements.processor';
import { AchievementsController } from './achievements.controller';
import { ACHIEVEMENTS_QUEUE } from './constants/achievements.constants';
import { LoyaltyModule } from 'src/loyalty/loyalty.module';
import { AchievementMapper } from './mappers/achievement.mapper';

@Module({
  imports: [
    forwardRef(() => LoyaltyModule),
    PrismaModule,
    BullModule.registerQueue({ name: ACHIEVEMENTS_QUEUE }),
  ],
  controllers: [AchievementsController],
  providers: [
    AchievementsService,
    AdminAchievementsService,
    AchievementsProcessor,
    AchievementMapper,
  ],
  exports: [AchievementsService, AdminAchievementsService],
})
export class AchievementsModule {}
