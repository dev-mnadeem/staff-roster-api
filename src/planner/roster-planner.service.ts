import { Injectable, Logger } from '@nestjs/common';
import { AssignmentRepository } from '@/database/repositories/assignment.repository';
import { PrismaService } from '@/database/prisma.service';
import { ConstraintEngine } from '@/constraints/constraint-engine';
import { toEvaluationContext } from '@/constraints/evaluation.mapper';
import type { ConstraintViolation } from '@/types/assignment';
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

type Candidate = {
  staffId: string;
  displayName: string | null;
  weeklyHours: number;
  premiumShifts: number;
};

@Injectable()
export class RosterPlannerService {
  private readonly logger = new Logger(RosterPlannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: AssignmentRepository,
    private readonly engine: ConstraintEngine,
  ) {}

  /**
   * Proposes assignments for every unfilled slot in a window.
   *
   * The approach is greedy with a fairness objective rather than a true
   * optimiser. Shifts are handled hardest-first — fewest eligible people
   * first — because filling an easy shift with someone who was the only
   * candidate for a hard one strands the hard one. Within a shift, the person
   * with the fewest hours that week wins, with premium-shift count breaking
   * ties so weekend work rotates.
   *
   * A full constraint solver would find better rosters. This runs in a request,
   * needs no solver dependency, and every decision it makes can be explained in
   * one sentence — which matters more when a manager has to defend the roster
   * to the person who got the Saturday night.
   *
   * Cost: eligibility is re-evaluated per slot, because placing someone changes
   * who is eligible for everything after it. That is O(slots × staff) calls to
   * loadEvaluationData, which is fine for a week at a handful of sites and
   * would need batching before it met a chain of hundreds.
   */
  async plan(input: {
    from: Date;
    to: Date;
    locationIds: string[];
  }): Promise<Omit<RosterPlan, 'explanation'>> {
    const shifts = await this.prisma.shift.findMany({
      where: {
        startAt: { gte: input.from, lt: input.to },
        ...(input.locationIds.length > 0
          ? { locationId: { in: input.locationIds } }
          : {}),
      },
      include: { assignments: true, location: true, requiredSkill: true },
      orderBy: { startAt: 'asc' },
    });

    const slotsTotal = shifts.reduce((sum, s) => sum + s.headcount, 0);
    const alreadyFilled = shifts.reduce(
      (sum, s) => sum + s.assignments.length,
      0,
    );

    // Score every shift's difficulty once, before placing anyone.
    const open = shifts
      .map((shift) => ({
        shift,
        remaining: shift.headcount - shift.assignments.length,
      }))
      .filter((entry) => entry.remaining > 0);

    const eligibility = new Map<string, Candidate[]>();
    for (const entry of open) {
      eligibility.set(
        entry.shift.id,
        await this.eligibleFor(
          entry.shift.id,
          entry.shift.locationId,
          entry.shift.requiredSkillId,
        ),
      );
    }

    // Hardest first: fewest candidates per remaining slot.
    open.sort((a, b) => {
      const aRatio = (eligibility.get(a.shift.id)?.length ?? 0) / a.remaining;
      const bRatio = (eligibility.get(b.shift.id)?.length ?? 0) / b.remaining;
      return aRatio - bRatio;
    });

    const hoursBefore = await this.weeklyHoursByStaff(input.from, input.to);
    const placed: PlannedAssignment[] = [];
    const unfilled: UnfilledSlot[] = [];
    // Tracks hours added by this plan, so later picks see earlier ones.
    const addedHours = new Map<string, number>();

    for (const entry of open) {
      const label = `${entry.shift.location.name} · ${entry.shift.requiredSkill.name}`;
      const taken = new Set(entry.shift.assignments.map((a) => a.staffId));
      let remaining = entry.remaining;

      while (remaining > 0) {
        // Recompute eligibility each pass: a placement made moments ago may
        // now double-book or breach rest for the next candidate.
        const candidates = (
          await this.eligibleFor(
            entry.shift.id,
            entry.shift.locationId,
            entry.shift.requiredSkillId,
          )
        ).filter((c) => !taken.has(c.staffId));

        if (candidates.length === 0) break;

        candidates.sort((a, b) => {
          const aHours =
            (hoursBefore.get(a.staffId) ?? 0) +
            (addedHours.get(a.staffId) ?? 0);
          const bHours =
            (hoursBefore.get(b.staffId) ?? 0) +
            (addedHours.get(b.staffId) ?? 0);
          if (aHours !== bHours) return aHours - bHours;
          return a.premiumShifts - b.premiumShifts;
        });

        const pick = candidates[0];
        const runningHours =
          (hoursBefore.get(pick.staffId) ?? 0) +
          (addedHours.get(pick.staffId) ?? 0);

        placed.push({
          shiftId: entry.shift.id,
          staffId: pick.staffId,
          staffName: pick.displayName ?? 'Unnamed',
          weeklyHoursBefore: Number(runningHours.toFixed(1)),
          premiumShiftsBefore: pick.premiumShifts,
          reason: this.reasonFor(pick, candidates, runningHours),
        });

        taken.add(pick.staffId);
        const shiftHours =
          (entry.shift.endAt.getTime() - entry.shift.startAt.getTime()) /
          3_600_000;
        addedHours.set(
          pick.staffId,
          (addedHours.get(pick.staffId) ?? 0) + shiftHours,
        );
        remaining -= 1;
      }

      if (remaining > 0) {
        unfilled.push({
          shiftId: entry.shift.id,
          shiftLabel: label,
          remaining,
          blockers: await this.blockersFor(entry.shift.id, taken),
        });
      }
    }

    const hoursAfter = new Map(hoursBefore);
    for (const [staffId, added] of addedHours) {
      hoursAfter.set(staffId, (hoursAfter.get(staffId) ?? 0) + added);
    }

    return {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      locationIds: input.locationIds,
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
        hoursSpreadBefore: this.spread([...hoursBefore.values()]),
        hoursSpreadAfter: this.spread([...hoursAfter.values()]),
      },
    };
  }

  // -- helpers ---------------------------------------------------------

  /** Everyone who clears every constraint rule for this shift. */
  private async eligibleFor(
    shiftId: string,
    locationId: string,
    requiredSkillId: string,
  ): Promise<Candidate[]> {
    const pool = await this.prisma.user.findMany({
      where: {
        role: 'staff',
        skills: { some: { skillId: requiredSkillId } },
        certifications: { some: { locationId } },
      },
      select: { id: true, displayName: true },
    });

    const out: Candidate[] = [];
    for (const staff of pool) {
      const data = await this.assignments.loadEvaluationData(shiftId, staff.id);
      const context = toEvaluationContext(data);
      if (!context) continue;
      if (!this.engine.evaluate(context).allowed) continue;
      out.push({
        staffId: staff.id,
        displayName: staff.displayName,
        weeklyHours: 0,
        premiumShifts: 0,
      });
    }
    return out;
  }

  /** Why nobody else could take the remaining slots. */
  private async blockersFor(
    shiftId: string,
    taken: Set<string>,
  ): Promise<UnfilledSlot['blockers']> {
    const shift = await this.prisma.shift.findUnique({
      where: { id: shiftId },
      select: { locationId: true, requiredSkillId: true },
    });
    if (!shift) return [];

    const pool = await this.prisma.user.findMany({
      where: { role: 'staff' },
      select: { id: true },
    });

    const counts = new Map<string, number>();
    for (const staff of pool) {
      if (taken.has(staff.id)) continue;
      const data = await this.assignments.loadEvaluationData(shiftId, staff.id);
      const context = toEvaluationContext(data);
      if (!context) continue;
      const result = this.engine.evaluate(context);
      if (result.allowed) continue;
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

  /** Hours already scheduled per staff member in the window. */
  private async weeklyHoursByStaff(
    from: Date,
    to: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.shiftAssignment.findMany({
      where: { shift: { startAt: { gte: from, lt: to } } },
      select: {
        staffId: true,
        shift: { select: { startAt: true, endAt: true } },
      },
    });

    const map = new Map<string, number>();
    for (const row of rows) {
      const hours =
        (row.shift.endAt.getTime() - row.shift.startAt.getTime()) / 3_600_000;
      map.set(row.staffId, (map.get(row.staffId) ?? 0) + hours);
    }

    // Staff with no shifts must appear as 0, or the spread looks artificially
    // tight — the people with nothing are exactly the ones fairness is about.
    const everyone = await this.prisma.user.findMany({
      where: { role: 'staff' },
      select: { id: true },
    });
    for (const staff of everyone) {
      if (!map.has(staff.id)) map.set(staff.id, 0);
    }
    return map;
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
