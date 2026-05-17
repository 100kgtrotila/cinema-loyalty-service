import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LoyaltyService } from './loyalty.service';
import { TicketPurchasedConsumer } from './consumers/ticket-purchased.consumer';
import { TierUpgradeListener } from './notifications/tier-upgrade.listener';
import { LoyaltyController } from './loyalty.controller';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
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
  providers: [LoyaltyService, TierUpgradeListener],
  controllers: [TicketPurchasedConsumer, LoyaltyController],
})
export class LoyaltyModule {}
