import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  IsTimeZone,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { WALL_CLOCK_TIME } from '@/common/validation/wall-clock';

export class CreateRecurringAvailabilityDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0=Sunday' })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty({ example: '09:00' })
  @IsString()
  @Matches(WALL_CLOCK_TIME, {
    message: 'startTime must be HH:MM (00:00–24:00)',
  })
  startTime!: string;

  @ApiProperty({ example: '17:00' })
  @IsString()
  @Matches(WALL_CLOCK_TIME, { message: 'endTime must be HH:MM (00:00–24:00)' })
  endTime!: string;

  @ApiProperty({ description: 'IANA timezone identifier' })
  @IsTimeZone()
  timezone!: string;
}

export class UpdateRecurringAvailabilityDto extends CreateRecurringAvailabilityDto {}
