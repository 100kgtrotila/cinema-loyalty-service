// src/loyalty/loyalty.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PrismaModule } from '../prisma/prisma.module';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyController } from './loyalty.controller';
import { TicketPurchasedConsumer } from './consumers/ticket-purchased.consumer';
import { TierUpgradeListener } from './notifications/tier-upgrade.listener';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ClientsModule.register([
      {
        name: 'LOYALTY_PUBLISHER',
        transport: Transport.RMQ,
        options: {
          urls: [process.env.RABBITMQ_URL ?? 'amqp://localhost:5672'],
          queue: 'loyalty.events',
          queueOptions: { durable: true },
        },
      },
    ]),
  ],
  controllers: [
    LoyaltyController,
    TicketPurchasedConsumer,
    OrderCancelledConsumer,
  ],
  providers: [
    LoyaltyService,
    TierUpgradeListener,
    LoyaltySchedulerService,
    GrpcApiKeyGuard,
  ],
})
export class LoyaltyModule {}
