import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { AchievementsService } from './achievements.service';
import { AchievementsProcessor } from './processors/achievements.processor';
import { ACHIEVEMENTS_QUEUE } from './constants/achievements.constants';
import { LoyaltyModule } from 'src/loyalty/loyalty.module';

@Module({
  imports: [
    forwardRef(() => LoyaltyModule),
    PrismaModule,
    BullModule.registerQueue({
      name: ACHIEVEMENTS_QUEUE,
    }),
  ],
  controllers: [],
  providers: [AchievementsService, AchievementsProcessor],
  exports: [AchievementsService],
})
export class AchievementsModule {}
