import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { PlanRosterDto } from '@/planner/dto/plan.dto';
import { PlanExplainerService } from '@/planner/plan-explainer.service';
import { RosterPlannerService } from '@/planner/roster-planner.service';
import type { RosterPlan } from '@/planner/planner.types';
import type { AuthenticatedUser } from '@/types/auth';

@ApiTags('Planner')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('planner')
export class PlannerController {
  constructor(
    private readonly planner: RosterPlannerService,
    private readonly explainer: PlanExplainerService,
  ) {}

  /**
   * Proposes a roster. Writes nothing.
   *
   * A POST rather than a GET because planning is expensive and takes a body,
   * but it is deliberately non-mutating: the manager reviews the proposal and
   * applies the assignments they want through the existing endpoints. An
   * auto-scheduler that silently rosters people is not a feature anyone asked
   * for.
   */
  @Post('plan')
  @HttpCode(HttpStatus.OK)
  @Roles('admin', 'manager')
  @ApiOperation({
    summary: 'Propose assignments for unfilled slots in a date range',
  })
  @ApiOkResponse({ description: 'A proposed roster, with reasoning.' })
  @ApiBadRequestResponse({ description: 'Empty or longer than 31-day range' })
  @ApiForbiddenResponse({ description: 'A location outside your management' })
  async plan(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PlanRosterDto,
  ): Promise<RosterPlan> {
    const core = await this.planner.planForActor(user.id, {
      from: new Date(dto.from),
      to: new Date(dto.to),
      locationIds: dto.locationIds,
    });
    const explanation = await this.explainer.explain(core);
    return { ...core, explanation };
  }
}
