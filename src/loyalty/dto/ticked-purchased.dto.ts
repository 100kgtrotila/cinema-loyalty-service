import { IsNumber, IsEnum, IsDateString, IsUUID, Min } from 'class-validator';
import { EventType } from '../enums/event-type.enum';

export class TicketPurchasedDto {
  @IsUUID()
  eventId!: string;

  @IsUUID()
  userId!: string;

  @IsUUID()
  orderId!: string;

  @IsNumber()
  @Min(0)
  totalAmount!: number;

  @IsNumber()
  @Min(0)
  ticketAmount!: number;

  @IsNumber()
  @Min(0)
  foodAmount!: number;

  @IsEnum(EventType)
  eventType!: EventType;

  @IsDateString()
  purchasedAt!: string;
}
