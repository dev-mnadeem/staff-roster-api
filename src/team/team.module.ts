import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { TeamController } from '@/team/team.controller';
import { TeamService } from '@/team/team.service';

@Module({
  controllers: [TeamController],
  providers: [TeamService, JwtAuthGuard, RolesGuard],
  exports: [TeamService],
})
export class TeamModule {}
