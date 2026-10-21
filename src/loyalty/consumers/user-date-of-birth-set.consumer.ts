import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoyaltyService } from '../loyalty.service';
import { UserDateOfBirthSetDto } from '../dto/user-date-of-birth-set.dto';
import { EventPatternType } from '../enums/loyalty.enums';
import { RmqDeliveryService } from './rmq-delivery.service';
import { PermanentMessageError } from './message-failure';

type RawDateOfBirthPayload = Record<string, unknown>;

@Controller()
export class UserDateOfBirthSetConsumer {
  constructor(
    private readonly loyaltyService: LoyaltyService,
    private readonly deliveries: RmqDeliveryService,
  ) {}

  @EventPattern(EventPatternType.USER_DATE_OF_BIRTH_SET)
  async handle(
    @Payload() data: unknown,
    @Ctx() ctx: RmqContext,
  ): Promise<void> {
    await this.deliveries.handle('UserDateOfBirthSet', data, ctx, async () => {
      if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw new PermanentMessageError('INVALID_DOB_PAYLOAD');
      const dto = plainToInstance(
        UserDateOfBirthSetDto,
        this.normalizePayload(data),
      );
      const errors = await validate(dto, {
        validationError: { target: false, value: false },
      });
      if (errors.length > 0)
        throw new PermanentMessageError('INVALID_DOB_PAYLOAD');
      await this.loyaltyService.processUserDateOfBirthSet(dto);
    });
  }

  private normalizePayload(data: unknown): unknown {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return data;
    }

    const payload = data as RawDateOfBirthPayload;

    return {
      ...payload,
      dateOfBirth: payload.dateOfBirth ?? payload.dob ?? payload.birthdayDate,
    };
  }
}
