import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { ShiftsController } from '@/shifts/shifts.controller';
import { ShiftsService } from '@/shifts/shifts.service';

@Module({
  controllers: [ShiftsController],
  providers: [ShiftsService, JwtAuthGuard, RolesGuard],
  exports: [ShiftsService],
})
export class ShiftsModule {}
