import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { AchievementsService } from './achievements.service';
import { AchievementsProcessor } from './processors/achievements.processor';
import { ACHIEVEMENTS_QUEUE } from './constants/achievements.constants';
import { AchievementsController } from './achievements.controller';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: ACHIEVEMENTS_QUEUE,
    }),
  ],
  controllers: [AchievementsController],
  providers: [AchievementsService, AchievementsProcessor],
  exports: [AchievementsService],
})
export class AchievementsModule {}
