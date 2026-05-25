import { forwardRef, Module } from '@nestjs/common';
import { AdminLoyaltyService } from './admin-loyalty.service';
import { PrismaModule } from '../prisma/prisma.module';
import { LoyaltyModule } from 'src/loyalty/loyalty.module';

@Module({
  imports: [PrismaModule, forwardRef(() => LoyaltyModule)],
  controllers: [],
  providers: [AdminLoyaltyService],
  exports: [AdminLoyaltyService],
})
export class AdminLoyaltyModule {}
