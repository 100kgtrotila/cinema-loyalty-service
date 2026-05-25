import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClientsModule } from '@nestjs/microservices';
import { PrismaModule } from '../prisma/prisma.module';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyController } from './loyalty.controller';
import { TicketPurchasedConsumer } from './consumers/ticket-purchased.consumer';
import { TierUpgradeListener } from './notifications/tier-upgrade.listener';
import { BullModule } from '@nestjs/bullmq';
import { getBullConfig } from 'src/config/bullmq.config';
import { getRabbitMqConfig } from 'src/config/rabbitmq.config';
import {
  INJECTION_TOKENS,
  LOYALTY_QUEUE_NAME,
} from './constants/loyalty.constants';
import { LoyaltyExpirationService } from './loyalty-expiration.service';
import { LoyaltySchedulerProducer } from './producers/loyalty-scheduler.producer';
import { LoyaltyQueueProcessor } from './processors/loyalty-queue.processor';
import { LoyaltyCalculatorService } from './loyalty-calculator.service';
import { ScheduleModule } from '@nestjs/schedule';
import { OutboxPublisherService } from './outbox-publisher.service';
import { AchievementsModule } from 'src/achievements/achievements.module';
import { AdminLoyaltyModule } from 'src/admin-loyalty/admin-loyalty.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    AchievementsModule,
    forwardRef(() => AdminLoyaltyModule),
    // BULL MQ
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: getBullConfig,
    }),
    BullModule.registerQueue({
      name: LOYALTY_QUEUE_NAME,
    }),
    // RABBIT MQ
    ClientsModule.registerAsync([
      {
        name: INJECTION_TOKENS.RABBITMQ_LOYALTY_CLIENT,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: getRabbitMqConfig,
      },
    ]),
  ],
  controllers: [LoyaltyController, TicketPurchasedConsumer],
  providers: [
    LoyaltyService,
    LoyaltyExpirationService,
    LoyaltySchedulerProducer,
    LoyaltyQueueProcessor,
    TierUpgradeListener,
    LoyaltyCalculatorService,
    OutboxPublisherService,
  ],
  exports: [LoyaltyService, LoyaltyCalculatorService],
})
export class LoyaltyModule {}
