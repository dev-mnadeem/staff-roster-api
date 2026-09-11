import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { SkillsController } from '@/skills/skills.controller';
import { SkillsService } from '@/skills/skills.service';

@Module({
  controllers: [SkillsController],
  providers: [SkillsService, JwtAuthGuard, RolesGuard],
  exports: [SkillsService],
})
export class SkillsModule {}
