import {
  IsUUID,
  IsInt,
  IsString,
  IsNotEmpty,
  NotEquals,
  MinLength,
} from 'class-validator';

export class ModifyPointsDto {
  @IsUUID()
  userId!: string;

  @IsInt()
  @NotEquals(0, { message: 'Points modification value must be non-zero.' })
  points!: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(5, { message: 'Reason must be at least 5 characters long.' })
  reason!: string;
}
