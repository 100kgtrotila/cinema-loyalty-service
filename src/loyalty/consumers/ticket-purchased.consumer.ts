import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Channel, ConsumeMessage } from 'amqplib';
import { LoyaltyService } from '../loyalty.service';
import { TicketPurchasedDto } from '../dto/ticked-purchased.dto';
import { EventPatternType } from '../enums/loyalty.enums';

@Controller()
export class TicketPurchasedConsumer {
  private readonly logger = new Logger(TicketPurchasedConsumer.name);

  constructor(private readonly loyaltyService: LoyaltyService) {}

  @EventPattern(EventPatternType.TICKET_PURCHASED)
  async handle(
    @Payload() data: unknown,
    @Ctx() ctx: RmqContext,
  ): Promise<void> {
    this.logger.log(
      `TicketPurchased message received: ${JSON.stringify(data)}`,
    );
    const channel = ctx.getChannelRef() as Channel;
    const originalMsg = ctx.getMessage() as ConsumeMessage;

    this.logger.log('TicketPurchasedConsumer received message');
    this.logger.debug('Raw payload:', JSON.stringify(data));

    try {
      const dto = plainToInstance(TicketPurchasedDto, data);
      const errors = await validate(dto);

      if (errors.length > 0) {
        this.logger.error('Validation failed:', errors);
        channel.nack(originalMsg, false, false);
        return;
      }

      await this.loyaltyService.processTicketPurchase(dto);
      channel.ack(originalMsg);
      this.logger.log(`Points processed for userId: ${dto.userId}`);
    } catch (error) {
      this.logger.error('Failed to process TicketPurchased:', error);
      channel.nack(originalMsg, false, true);
    }
  }
}
