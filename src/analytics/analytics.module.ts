import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { AnalyticsController } from '@/analytics/analytics.controller';
import { AnalyticsService } from '@/analytics/analytics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, JwtAuthGuard, RolesGuard],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
