import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { LocationsController } from '@/locations/locations.controller';
import { LocationsService } from '@/locations/locations.service';

@Module({
  controllers: [LocationsController],
  providers: [LocationsService, JwtAuthGuard, RolesGuard],
  exports: [LocationsService],
})
export class LocationsModule {}
