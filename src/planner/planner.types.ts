/**
 * Types for automatic roster planning.
 *
 * A plan is always a *proposal*. Nothing is written until a manager accepts it,
 * because the planner optimises for measurable things — coverage, an even
 * spread of hours, fair rotation of premium shifts — and cannot know that
 * someone is training a new hire on Thursday.
 */

export type PlannedAssignment = {
  shiftId: string;
  staffId: string;
  staffName: string;
  /** Why this person, in plain English. */
  reason: string;
  /** Hours this person had that week before the assignment. */
  weeklyHoursBefore: number;
  /** Premium shifts they had already worked in the reporting window. */
  premiumShiftsBefore: number;
};

export type UnfilledSlot = {
  shiftId: string;
  shiftLabel: string;
  /** Slots still open on this shift after planning. */
  remaining: number;
  /** Why nobody could be placed, ordered most to least common. */
  blockers: Array<{ reason: string; staffCount: number }>;
};

export type PlanExplanation = {
  /** One-paragraph narrative of what the plan does and what it could not do. */
  summary: string;
  /** How the summary was produced, so a reader knows what they are trusting. */
  source: 'model' | 'rules';
};

export type RosterPlan = {
  from: string;
  to: string;
  locationIds: string[];
  assignments: PlannedAssignment[];
  unfilled: UnfilledSlot[];
  metrics: {
    slotsTotal: number;
    slotsFilled: number;
    /** Filled as a fraction of total. */
    coverage: number;
    /**
     * Spread of weekly hours across staff after planning — lower is fairer.
     * Reported alongside the "before" value so the effect is visible.
     */
    hoursSpreadBefore: number;
    hoursSpreadAfter: number;
  };
  explanation: PlanExplanation;
};
