import { Module } from '@nestjs/common';
import { AdminLoyaltyController } from './admin-loyalty.controller';
import { AdminLoyaltyService } from './admin-loyalty.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AdminLoyaltyController],
  providers: [AdminLoyaltyService],
})
export class AdminLoyaltyModule {}
