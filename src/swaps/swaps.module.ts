import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { SwapsController } from '@/swaps/swaps.controller';
import { SwapsService } from '@/swaps/swaps.service';

@Module({
  controllers: [SwapsController],
  providers: [SwapsService, JwtAuthGuard, RolesGuard],
  exports: [SwapsService],
})
export class SwapsModule {}
