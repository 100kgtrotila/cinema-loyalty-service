import { IsOptional, IsString, IsUUID } from 'class-validator';

export class UserDateOfBirthSetDto {
  @IsOptional()
  @IsString()
  eventId?: string;

  @IsUUID()
  userId!: string;

  @IsString()
  dateOfBirth!: string;

  @IsOptional()
  @IsString()
  occurredAtUtc?: string;
}
