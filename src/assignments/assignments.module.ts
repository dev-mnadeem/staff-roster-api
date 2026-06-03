import { Module } from '@nestjs/common';
import { RolesGuard } from '@/common/guards/roles.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { AssignmentsController } from '@/assignments/assignments.controller';
import { AssignmentsService } from '@/assignments/assignments.service';

@Module({
  controllers: [AssignmentsController],
  providers: [AssignmentsService, JwtAuthGuard, RolesGuard],
  exports: [AssignmentsService],
})
export class AssignmentsModule {}
