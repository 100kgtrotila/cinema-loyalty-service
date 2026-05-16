import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Channel, ConsumeMessage } from 'amqplib';
import { LoyaltyService } from '../loyalty.service';
import { TicketPurchasedDto } from '../dto/ticked-purchased.dto';

@Controller()
export class TicketPurchasedConsumer {
  private readonly logger = new Logger(TicketPurchasedConsumer.name);

  constructor(private readonly loyaltyService: LoyaltyService) {}

  @MessagePattern('ticket.purchased')
  async handle(
    @Payload() data: unknown,
    @Ctx() ctx: RmqContext,
  ): Promise<void> {
    const channel = ctx.getChannelRef() as Channel;
    const message = ctx.getMessage() as ConsumeMessage;

    const dto = plainToInstance(TicketPurchasedDto, data);
    const errors = await validate(dto);

    if (errors.length > 0) {
      this.logger.warn(
        `Invalid message rejected: ${JSON.stringify(errors.map((e) => e.constraints))}`,
      );
      channel.nack(message, false, false);
      return;
    }

    try {
      await this.loyaltyService.processTicketPurchase(dto);
      channel.ack(message);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Processing failed, nacking for retry: ${msg}`);
      channel.nack(message, false, true);
    }
  }
}
