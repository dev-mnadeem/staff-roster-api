import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsOptional, IsUUID } from 'class-validator';

export class PlanRosterDto {
  @ApiProperty({ example: '2026-09-01T00:00:00.000Z' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-09-08T00:00:00.000Z' })
  @IsDateString()
  to!: string;

  @ApiProperty({
    required: false,
    type: [String],
    description: 'Limit to these locations. Omit for every location in scope.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @Type(() => String)
  locationIds?: string[];
}
