import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
} from 'class-validator';
import { WALL_CLOCK_TIME } from '@/common/validation/wall-clock';

export class CreateAvailabilityExceptionDto {
  @ApiProperty({ format: 'date', example: '2026-05-15' })
  @Type(() => Date)
  @IsDate()
  date!: Date;

  @ApiProperty()
  @IsBoolean()
  isAvailable!: boolean;

  @ApiProperty({ required: false, example: '14:00' })
  @IsOptional()
  @IsString()
  @Matches(WALL_CLOCK_TIME, {
    message: 'startTime must be HH:MM (00:00–24:00)',
  })
  startTime?: string;

  @ApiProperty({ required: false, example: '17:00' })
  @IsOptional()
  @IsString()
  @Matches(WALL_CLOCK_TIME, { message: 'endTime must be HH:MM (00:00–24:00)' })
  endTime?: string;

  @ApiProperty()
  @IsTimeZone()
  timezone!: string;
}

export class UpdateAvailabilityExceptionDto extends CreateAvailabilityExceptionDto {}
