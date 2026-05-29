import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Channel, ConsumeMessage } from 'amqplib';
import { LoyaltyService } from '../loyalty.service';
import { UserDateOfBirthSetDto } from '../dto/user-date-of-birth-set.dto';
import { EventPatternType } from '../enums/loyalty.enums';

type RawDateOfBirthPayload = Record<string, unknown>;

@Controller()
export class UserDateOfBirthSetConsumer {
  private readonly logger = new Logger(UserDateOfBirthSetConsumer.name);

  constructor(private readonly loyaltyService: LoyaltyService) {}

  @EventPattern(EventPatternType.USER_DATE_OF_BIRTH_SET)
  async handle(
    @Payload() data: unknown,
    @Ctx() ctx: RmqContext,
  ): Promise<void> {
    const channel = ctx.getChannelRef() as Channel;
    const originalMsg = ctx.getMessage() as ConsumeMessage;

    this.logger.debug(
      `UserDateOfBirthSet message received: ${JSON.stringify(data)}`,
    );

    try {
      const dto = plainToInstance(
        UserDateOfBirthSetDto,
        this.normalizePayload(data),
      );
      const errors = await validate(dto);

      if (errors.length > 0) {
        this.logger.warn(
          `Invalid DOB payload received: ${JSON.stringify(errors)}`,
        );
        channel.ack(originalMsg);
        return;
      }

      await this.loyaltyService.processUserDateOfBirthSet(dto);
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error('Failed to process UserDateOfBirthSet:', error);
      channel.nack(originalMsg, false, true);
    }
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
