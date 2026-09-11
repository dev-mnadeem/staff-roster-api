import { Module } from '@nestjs/common';
import { ConstraintsModule } from '@/constraints/constraints.module';
import { PlannerController } from '@/planner/planner.controller';
import { PlanExplainerService } from '@/planner/plan-explainer.service';
import { RosterPlannerService } from '@/planner/roster-planner.service';

@Module({
  imports: [ConstraintsModule],
  controllers: [PlannerController],
  providers: [RosterPlannerService, PlanExplainerService],
  exports: [RosterPlannerService],
})
export class PlannerModule {}
