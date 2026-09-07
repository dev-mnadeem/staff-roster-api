import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { OnDutyController } from '@/on-duty/on-duty.controller';
import { OnDutyService } from '@/on-duty/on-duty.service';

@Module({
  controllers: [OnDutyController],
  providers: [OnDutyService, JwtAuthGuard],
  exports: [OnDutyService],
})
export class OnDutyModule {}
