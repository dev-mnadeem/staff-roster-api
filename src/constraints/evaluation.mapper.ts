import type { EvaluationData } from '@/database/repositories/assignment.repository';
import type { EvaluationContext } from '@/constraints/constraint-engine';

/**
 * Turns the rows the repository loads into the shape the constraint engine
 * expects.
 *
 * Lives on its own because two callers need it — the assignment flow, which
 * evaluates one person against one shift, and the roster planner, which
 * evaluates many. Keeping one copy means a change to the engine's input shape
 * cannot leave the planner silently evaluating against a stale mapping.
 *
 * Returns null when either side of the pairing is missing, so callers decide
 * how to report it rather than having an error shape forced on them.
 */
export function toEvaluationContext(
  data: EvaluationData,
): EvaluationContext | null {
  if (!data.shift || !data.staff) return null;

  return {
    staff: {
      id: data.staff.id,
      displayName: data.staff.displayName,
      certifiedLocationIds: new Set(
        data.staff.certifications.map((c) => c.locationId),
      ),
      skillIds: new Set(data.staff.skills.map((s) => s.skillId)),
    },
    shift: {
      id: data.shift.id,
      locationId: data.shift.locationId,
      startAt: data.shift.startAt,
      endAt: data.shift.endAt,
      requiredSkillId: data.shift.requiredSkillId,
      locationTimezone: data.shift.location.timezone,
    },
    availability: {
      recurring: data.staff.recurringAvailability.map((r) => ({
        weekday: r.weekday,
        startTime: r.startTime,
        endTime: r.endTime,
        timezone: r.timezone,
      })),
      exceptions: data.staff.availabilityExceptions.map((e) => ({
        date: e.date.toISOString().slice(0, 10),
        isAvailable: e.isAvailable,
        startTime: e.startTime,
        endTime: e.endTime,
        timezone: e.timezone,
      })),
    },
    existingAssignments: data.staffAssignments.map((a) => ({
      shiftId: a.shift.id,
      startAt: a.shift.startAt,
      endAt: a.shift.endAt,
      locationTimezone: a.shift.location.timezone,
    })),
    overtimeOverrides: data.overrides.map((o) => ({
      effectiveDate: o.effectiveDate.toISOString().slice(0, 10),
    })),
  };
}
