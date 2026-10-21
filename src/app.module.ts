import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import appConfig from './config/app.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      skipProcessEnv: true,
    }),
    PrismaModule,
    LoyaltyModule,
    EventEmitterModule.forRoot(),
  ],
})
export class AppModule {}
