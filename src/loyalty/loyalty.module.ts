import { Module } from '@nestjs/common';
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

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    EventEmitterModule.forRoot(),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: getBullConfig,
    }),
    ClientsModule.registerAsync([
      {
        name: 'LOYALTY_PUBLISHER',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: getRabbitMqConfig,
      },
    ]),
  ],
  controllers: [LoyaltyController, TicketPurchasedConsumer],
  providers: [LoyaltyService, TierUpgradeListener],
})
export class LoyaltyModule {}
