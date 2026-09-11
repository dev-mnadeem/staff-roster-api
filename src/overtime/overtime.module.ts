import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { OvertimeController } from '@/overtime/overtime.controller';
import { OvertimeService } from '@/overtime/overtime.service';

@Module({
  controllers: [OvertimeController],
  providers: [OvertimeService, JwtAuthGuard, RolesGuard],
  exports: [OvertimeService],
})
export class OvertimeModule {}
