import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Location, Shift } from '@prisma/client';
import {
  AssignmentRepository,
  type EvaluationData,
} from '@/database/repositories/assignment.repository';
import { PrismaService } from '@/database/prisma.service';
import { LocationScopeService } from '@/common/scope/location-scope.service';
import {
  ConstraintEngine,
  type ExistingAssignment,
} from '@/constraints/constraint-engine';
import { toEvaluationContext } from '@/constraints/evaluation.mapper';
import type { ConstraintResult, ConstraintViolation } from '@/types/assignment';
import {
  PlannedAssignment,
  RosterPlan,
  UnfilledSlot,
} from '@/planner/planner.types';

/** Human-readable text for each rule the engine can reject on. */
const BLOCKER_TEXT: Record<string, string> = {
  not_certified: 'not certified at this location',
  missing_skill: 'lacks the required skill',
  unavailable: 'unavailable at that time',
  double_booking: 'already working an overlapping shift',
  min_rest: 'would not get the minimum rest',
  daily_overtime_block: 'would exceed the daily hours limit',
  consecutive_7_block: 'would be a seventh consecutive day',
};

/** Longest window one request may plan; each extra day multiplies the work. */
export const MAX_PLAN_DAYS = 31;

type PlanShift = Shift & { location: Location };

type Candidate = {
  staffId: string;
  displayName: string | null;
};

/**
 * Everything a single planning run accumulates. The database does not change
 * while a plan is computed — nothing is written — so evaluation data is loaded
 * once per (shift, person) and the plan's own placements are layered on top.
 */
type PlanState = {
  planned: Map<string, ExistingAssignment[]>;
  evaluationData: Map<string, EvaluationData>;
  pools: Map<string, Candidate[]>;
};

@Injectable()
export class RosterPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentRepository,
    private readonly engine: ConstraintEngine,
    private readonly scope: LocationScopeService,
  ) {}

  /**
   * Plans within the caller's reach: admins anywhere, managers only at the
   * locations they manage — by default all of them.
   */
  async planForActor(
    actorId: string,
    input: { from: Date; to: Date; locationIds?: string[] },
  ): Promise<Omit<RosterPlan, 'explanation'>> {
    const spanDays = (input.to.getTime() - input.from.getTime()) / 86_400_000;
    if (!(spanDays > 0)) {
      throw new BadRequestException('"to" must be after "from"');
    }
    if (spanDays > MAX_PLAN_DAYS) {
      throw new BadRequestException(
        `Plan at most ${MAX_PLAN_DAYS} days at a time`,
      );
    }

    const ctx = await this.scope.contextFor(actorId);
    let locationIds: string[] | null = input.locationIds?.length
      ? input.locationIds
      : null;
    if (ctx.managedLocationIds !== null) {
      const managed = ctx.managedLocationIds;
      if (locationIds) {
        const outside = locationIds.filter((id) => !managed.includes(id));
        if (outside.length > 0) {
          throw new ForbiddenException(
            `You do not manage location(s): ${outside.join(', ')}`,
          );
        }
      } else {
        locationIds = managed;
      }
    }

    return this.plan({ from: input.from, to: input.to, locationIds });
  }

  /**
   * Proposes assignments for every unfilled slot in a window.
   *
   * The approach is greedy with a fairness objective rather than a true
   * optimiser. Shifts are handled hardest-first — fewest eligible people
   * first — because filling an easy shift with someone who was the only
   * candidate for a hard one strands the hard one. Within a shift, the person
   * with the fewest hours in the window wins, with premium-shift count
   * breaking ties so weekend work rotates.
   *
   * A full constraint solver would find better rosters. This runs in a request,
   * needs no solver dependency, and every decision it makes can be explained in
   * one sentence — which matters more when a manager has to defend the roster
   * to the person who got the Saturday night.
   *
   * Eligibility is re-evaluated per slot, because placing someone changes who
   * is eligible for everything after it: each placement is fed back to the
   * constraint engine as if it were already rostered.
   *
   * `locationIds: null` plans every location.
   */
  async plan(input: {
    from: Date;
    to: Date;
    locationIds: string[] | null;
  }): Promise<Omit<RosterPlan, 'explanation'>> {
    const shifts = await this.prisma.shift.findMany({
      where: {
        startAt: { gte: input.from, lt: input.to },
        ...(input.locationIds ? { locationId: { in: input.locationIds } } : {}),
      },
      include: { assignments: true, location: true, requiredSkill: true },
      orderBy: { startAt: 'asc' },
    });

    const slotsTotal = shifts.reduce((sum, s) => sum + s.headcount, 0);
    const alreadyFilled = shifts.reduce(
      (sum, s) => sum + s.assignments.length,
      0,
    );

    const state: PlanState = {
      planned: new Map(),
      evaluationData: new Map(),
      pools: new Map(),
    };

    // Score every shift's difficulty once, before placing anyone.
    const open = shifts
      .map((shift) => ({
        shift,
        remaining: shift.headcount - shift.assignments.length,
      }))
      .filter((entry) => entry.remaining > 0);

    const difficulty = new Map<string, number>();
    for (const entry of open) {
      const eligible = await this.eligibleFor(entry.shift, state);
      difficulty.set(entry.shift.id, eligible.length / entry.remaining);
    }
    open.sort(
      (a, b) =>
        (difficulty.get(a.shift.id) ?? 0) - (difficulty.get(b.shift.id) ?? 0),
    );

    const before = await this.workloadByStaff(input.from, input.to);
    const hours = new Map(before.hours);
    const premium = new Map(before.premium);
    const placed: PlannedAssignment[] = [];
    const unfilled: UnfilledSlot[] = [];

    for (const entry of open) {
      const { shift } = entry;
      const label = `${shift.location.name} · ${shift.requiredSkill.name}`;
      const taken = new Set(shift.assignments.map((a) => a.staffId));
      const shiftHours =
        (shift.endAt.getTime() - shift.startAt.getTime()) / 3_600_000;
      let remaining = entry.remaining;

      while (remaining > 0) {
        const candidates = (await this.eligibleFor(shift, state)).filter(
          (c) => !taken.has(c.staffId),
        );
        if (candidates.length === 0) break;

        candidates.sort((a, b) => {
          const byHours =
            (hours.get(a.staffId) ?? 0) - (hours.get(b.staffId) ?? 0);
          if (byHours !== 0) return byHours;
          return (premium.get(a.staffId) ?? 0) - (premium.get(b.staffId) ?? 0);
        });

        const pick = candidates[0];
        const runningHours = hours.get(pick.staffId) ?? 0;
        const runningPremium = premium.get(pick.staffId) ?? 0;

        placed.push({
          shiftId: shift.id,
          staffId: pick.staffId,
          staffName: pick.displayName ?? 'Unnamed',
          weeklyHoursBefore: Number(runningHours.toFixed(1)),
          premiumShiftsBefore: runningPremium,
          reason: this.reasonFor(pick, candidates, runningHours),
        });

        taken.add(pick.staffId);
        hours.set(pick.staffId, runningHours + shiftHours);
        if (shift.isPremium) premium.set(pick.staffId, runningPremium + 1);
        const planned = state.planned.get(pick.staffId) ?? [];
        planned.push({
          shiftId: shift.id,
          startAt: shift.startAt,
          endAt: shift.endAt,
          locationTimezone: shift.location.timezone,
        });
        state.planned.set(pick.staffId, planned);
        remaining -= 1;
      }

      if (remaining > 0) {
        unfilled.push({
          shiftId: shift.id,
          shiftLabel: label,
          remaining,
          blockers: await this.blockersFor(shift, taken, state),
        });
      }
    }

    return {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      locationIds: input.locationIds ?? [],
      assignments: placed,
      unfilled,
      metrics: {
        slotsTotal,
        slotsFilled: alreadyFilled + placed.length,
        // Zero slots is "nothing to do", not "fully covered". Reporting 100%
        // for an empty range invites a manager to believe a week is staffed
        // when no shifts have been created for it yet.
        coverage:
          slotsTotal === 0
            ? 0
            : Number(((alreadyFilled + placed.length) / slotsTotal).toFixed(3)),
        hoursSpreadBefore: this.spread([...before.hours.values()]),
        hoursSpreadAfter: this.spread([...hours.values()]),
      },
    };
  }

  // -- helpers ---------------------------------------------------------

  /** Engine verdict for one person on one shift, counting the plan so far. */
  private async evaluate(
    shift: PlanShift,
    staffId: string,
    state: PlanState,
  ): Promise<ConstraintResult | null> {
    const key = `${shift.id}:${staffId}`;
    let data = state.evaluationData.get(key);
    if (!data) {
      data = await this.assignments.loadEvaluationData(shift.id, staffId);
      state.evaluationData.set(key, data);
    }
    const context = toEvaluationContext(data);
    if (!context) return null;
    context.existingAssignments.push(...(state.planned.get(staffId) ?? []));
    return this.engine.evaluate(context);
  }

  /** Everyone who clears every constraint rule for this shift. */
  private async eligibleFor(
    shift: PlanShift,
    state: PlanState,
  ): Promise<Candidate[]> {
    const poolKey = `${shift.locationId}:${shift.requiredSkillId}`;
    let pool = state.pools.get(poolKey);
    if (!pool) {
      const rows = await this.prisma.user.findMany({
        where: {
          role: 'staff',
          skills: { some: { skillId: shift.requiredSkillId } },
          certifications: { some: { locationId: shift.locationId } },
        },
        select: { id: true, displayName: true },
      });
      pool = rows.map((r) => ({ staffId: r.id, displayName: r.displayName }));
      state.pools.set(poolKey, pool);
    }

    const out: Candidate[] = [];
    for (const candidate of pool) {
      const result = await this.evaluate(shift, candidate.staffId, state);
      if (result?.allowed) out.push(candidate);
    }
    return out;
  }

  /** Why nobody else could take the remaining slots. */
  private async blockersFor(
    shift: PlanShift,
    taken: Set<string>,
    state: PlanState,
  ): Promise<UnfilledSlot['blockers']> {
    const everyone = await this.prisma.user.findMany({
      where: { role: 'staff' },
      select: { id: true },
    });

    const counts = new Map<string, number>();
    for (const staff of everyone) {
      if (taken.has(staff.id)) continue;
      const result = await this.evaluate(shift, staff.id, state);
      if (!result || result.allowed) continue;
      // Attribute each person to their single most fundamental blocker, so the
      // counts read as "6 lack the skill" rather than double-counting.
      const primary: ConstraintViolation | undefined = result.blocking[0];
      if (!primary) continue;
      const text = BLOCKER_TEXT[primary.rule] ?? primary.rule;
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([reason, staffCount]) => ({ reason, staffCount }))
      .sort((a, b) => b.staffCount - a.staffCount);
  }

  private reasonFor(
    pick: Candidate,
    candidates: Candidate[],
    runningHours: number,
  ): string {
    const name = pick.displayName ?? 'This person';
    if (candidates.length === 1) {
      return `${name} was the only person who cleared every rule for this shift.`;
    }
    const others = candidates.length - 1;
    return (
      `${name} had the fewest hours this week (${runningHours.toFixed(1)}h) ` +
      `among ${candidates.length} eligible staff, so taking it evens the ` +
      `spread against the other ${others}.`
    );
  }

  /** Hours and premium shifts already scheduled per staff member in the window. */
  private async workloadByStaff(
    from: Date,
    to: Date,
  ): Promise<{ hours: Map<string, number>; premium: Map<string, number> }> {
    const rows = await this.prisma.shiftAssignment.findMany({
      where: { shift: { startAt: { gte: from, lt: to } } },
      select: {
        staffId: true,
        shift: { select: { startAt: true, endAt: true, isPremium: true } },
      },
    });

    const hours = new Map<string, number>();
    const premium = new Map<string, number>();
    for (const row of rows) {
      const h =
        (row.shift.endAt.getTime() - row.shift.startAt.getTime()) / 3_600_000;
      hours.set(row.staffId, (hours.get(row.staffId) ?? 0) + h);
      if (row.shift.isPremium) {
        premium.set(row.staffId, (premium.get(row.staffId) ?? 0) + 1);
      }
    }

    // Staff with no shifts must appear as 0, or the spread looks artificially
    // tight — the people with nothing are exactly the ones fairness is about.
    const everyone = await this.prisma.user.findMany({
      where: { role: 'staff' },
      select: { id: true },
    });
    for (const staff of everyone) {
      if (!hours.has(staff.id)) hours.set(staff.id, 0);
    }
    return { hours, premium };
  }

  /** Population standard deviation; 0 when everyone has identical hours. */
  private spread(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Number(Math.sqrt(variance).toFixed(2));
  }
}
