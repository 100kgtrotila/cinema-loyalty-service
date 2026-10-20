import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoyaltyService } from '../loyalty.service';
import { TicketPurchasedDto } from '../dto/ticked-purchased.dto';
import { EventPatternType } from '../enums/loyalty.enums';
import { RmqDeliveryService } from './rmq-delivery.service';
import { PermanentMessageError } from './message-failure';

@Controller()
export class TicketPurchasedConsumer {
  constructor(
    private readonly loyaltyService: LoyaltyService,
    private readonly deliveries: RmqDeliveryService,
  ) {}

  @EventPattern(EventPatternType.TICKET_PURCHASED)
  async handle(
    @Payload() data: unknown,
    @Ctx() ctx: RmqContext,
  ): Promise<void> {
    await this.deliveries.handle('TicketPurchased', data, ctx, async () => {
      if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw new PermanentMessageError('INVALID_PURCHASE_PAYLOAD');
      const dto = plainToInstance(TicketPurchasedDto, data);
      const errors = await validate(dto, {
        validationError: { target: false, value: false },
      });
      if (errors.length > 0)
        throw new PermanentMessageError('INVALID_PURCHASE_PAYLOAD');
      await this.loyaltyService.processTicketPurchase(dto);
    });
  }
}
