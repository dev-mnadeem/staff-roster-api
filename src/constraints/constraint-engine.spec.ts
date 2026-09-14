import {
  ConstraintEngine,
  type EvaluationContext,
} from '@/constraints/constraint-engine';

/**
 * The constraint engine decides whether a person may be put on a shift. It is
 * the only place in the system that can produce an illegal roster, and it was
 * entirely untested.
 *
 * Every case below is expressed in wall-clock time at a named location, because
 * the rules are about human working conditions — "ten hours between shifts"
 * means ten real hours, whichever timezone each shift was scheduled in.
 */
describe('ConstraintEngine', () => {
  const engine = new ConstraintEngine();

  const LOCATION = 'loc-brooklyn';
  const SKILL = 'skill-server';
  const NY = 'America/New_York';

  /** 2026-03-02 is a Monday. Times are UTC; NY is UTC-5 that week. */
  const shiftAt = (startIso: string, endIso: string) => ({
    id: 'shift-1',
    locationId: LOCATION,
    startAt: new Date(startIso),
    endAt: new Date(endIso),
    requiredSkillId: SKILL,
    locationTimezone: NY,
  });

  const baseContext = (
    overrides: Partial<EvaluationContext> = {},
  ): EvaluationContext => ({
    staff: {
      id: 'staff-1',
      displayName: 'Sarah Chen',
      certifiedLocationIds: new Set([LOCATION]),
      skillIds: new Set([SKILL]),
    },
    // Monday 09:00–17:00 New York.
    shift: shiftAt('2026-03-02T14:00:00Z', '2026-03-02T22:00:00Z'),
    availability: {
      // Monday, 08:00–22:00 local — comfortably covers the shift.
      recurring: [
        { weekday: 1, startTime: '08:00', endTime: '22:00', timezone: NY },
      ],
      exceptions: [],
    },
    existingAssignments: [],
    overtimeOverrides: [],
    ...overrides,
  });

  const rules = (ctx: EvaluationContext) => {
    const result = engine.evaluate(ctx);
    return {
      allowed: result.allowed,
      blocking: result.blocking.map((v) => v.rule),
      warnings: result.warnings.map((v) => v.rule),
    };
  };

  it('allows a qualified, available person with a clear schedule', () => {
    const result = rules(baseContext());
    expect(result.allowed).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  describe('qualification', () => {
    it('blocks someone not certified at the location', () => {
      const ctx = baseContext();
      ctx.staff.certifiedLocationIds = new Set(['loc-boston']);
      expect(rules(ctx).blocking).toContain('not_certified');
    });

    it('blocks someone without the required skill', () => {
      const ctx = baseContext();
      ctx.staff.skillIds = new Set(['skill-bartender']);
      expect(rules(ctx).blocking).toContain('missing_skill');
    });

    it('reports every failure at once rather than stopping at the first', () => {
      // A manager fixing one problem should not discover the next on retry.
      const ctx = baseContext();
      ctx.staff.certifiedLocationIds = new Set([]);
      ctx.staff.skillIds = new Set([]);
      const result = rules(ctx);
      expect(result.blocking).toEqual(
        expect.arrayContaining(['not_certified', 'missing_skill']),
      );
    });
  });

  describe('availability', () => {
    it('blocks a shift outside the recurring window', () => {
      const ctx = baseContext();
      ctx.availability.recurring = [
        { weekday: 1, startTime: '08:00', endTime: '12:00', timezone: NY },
      ];
      expect(rules(ctx).blocking).toContain('unavailable');
    });

    it('blocks when the person has no availability at all', () => {
      const ctx = baseContext();
      ctx.availability.recurring = [];
      expect(rules(ctx).blocking).toContain('unavailable');
    });

    it('blocks on a day marked unavailable by exception', () => {
      const ctx = baseContext();
      ctx.availability.exceptions = [
        { date: '2026-03-02', isAvailable: false, timezone: NY },
      ];
      expect(rules(ctx).blocking).toContain('unavailable');
    });

    it('lets an exception open a day the recurring pattern excludes', () => {
      const ctx = baseContext();
      ctx.availability.recurring = [];
      ctx.availability.exceptions = [
        {
          date: '2026-03-02',
          isAvailable: true,
          startTime: '08:00',
          endTime: '22:00',
          timezone: NY,
        },
      ];
      expect(rules(ctx).blocking).not.toContain('unavailable');
    });
  });

  describe('conflicts with existing work', () => {
    it('blocks an overlapping shift', () => {
      const ctx = baseContext({
        existingAssignments: [
          {
            shiftId: 'other',
            startAt: new Date('2026-03-02T16:00:00Z'),
            endAt: new Date('2026-03-03T00:00:00Z'),
            locationTimezone: NY,
          },
        ],
      });
      expect(rules(ctx).blocking).toContain('double_booking');
    });

    it('blocks a shift that leaves less than the minimum rest', () => {
      // Previous shift ends 08:00 UTC; this one starts 14:00 UTC — 6 hours.
      const ctx = baseContext({
        existingAssignments: [
          {
            shiftId: 'night-before',
            startAt: new Date('2026-03-02T00:00:00Z'),
            endAt: new Date('2026-03-02T08:00:00Z'),
            locationTimezone: NY,
          },
        ],
      });
      expect(rules(ctx).blocking).toContain('min_rest');
    });

    it('allows a shift with more than the minimum rest', () => {
      // Ends 2026-03-01T22:00Z, starts 2026-03-02T14:00Z — 16 hours.
      const ctx = baseContext({
        existingAssignments: [
          {
            shiftId: 'day-before',
            startAt: new Date('2026-03-01T14:00:00Z'),
            endAt: new Date('2026-03-01T22:00:00Z'),
            locationTimezone: NY,
          },
        ],
      });
      expect(rules(ctx).blocking).not.toContain('min_rest');
    });
  });

  describe('consecutive days', () => {
    /** One 8-hour shift per day, counting back from the day before the shift. */
    const priorDays = (count: number) =>
      Array.from({ length: count }, (_, i) => {
        const day = new Date('2026-03-01T14:00:00Z');
        day.setUTCDate(day.getUTCDate() - i);
        const end = new Date(day);
        end.setUTCHours(end.getUTCHours() + 8);
        return {
          shiftId: `prior-${i}`,
          startAt: day,
          endAt: end,
          locationTimezone: NY,
        };
      });

    it('warns on the sixth consecutive day', () => {
      const ctx = baseContext({ existingAssignments: priorDays(5) });
      const result = rules(ctx);
      expect(result.warnings).toContain('consecutive_6_warn');
      expect(result.allowed).toBe(true);
    });

    it('blocks a seventh consecutive day', () => {
      const ctx = baseContext({ existingAssignments: priorDays(6) });
      const result = rules(ctx);
      expect(result.blocking).toContain('consecutive_7_block');
      expect(result.allowed).toBe(false);
    });

    it('permits a seventh day when an override has been granted', () => {
      // The override exists precisely so a manager can accept the exception
      // deliberately, with an audit trail, rather than being hard-stopped.
      const ctx = baseContext({
        existingAssignments: priorDays(6),
        overtimeOverrides: [{ effectiveDate: '2026-03-02' }],
      });
      expect(rules(ctx).blocking).not.toContain('consecutive_7_block');
    });
  });

  describe('overtime', () => {
    it('warns when the day runs long', () => {
      const ctx = baseContext({
        shift: shiftAt('2026-03-02T13:00:00Z', '2026-03-02T23:00:00Z'),
      });
      expect(rules(ctx).warnings).toContain('daily_overtime_warn');
    });

    it('blocks a day beyond the hard daily limit', () => {
      // 13 hours, past the 12-hour block threshold.
      const ctx = baseContext({
        shift: shiftAt('2026-03-02T11:00:00Z', '2026-03-03T00:00:00Z'),
      });
      ctx.availability.recurring = [
        { weekday: 1, startTime: '00:00', endTime: '23:59', timezone: NY },
      ];
      expect(rules(ctx).blocking).toContain('daily_overtime_block');
    });
  });
});
