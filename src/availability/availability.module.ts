import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { AvailabilityController } from '@/availability/availability.controller';
import { AvailabilityService } from '@/availability/availability.service';

@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityService, JwtAuthGuard, RolesGuard],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
