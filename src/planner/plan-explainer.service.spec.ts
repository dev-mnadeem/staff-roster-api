import { ConfigService } from '@nestjs/config';
import { PlanExplainerService } from '@/planner/plan-explainer.service';
import type { RosterPlan } from '@/planner/planner.types';

type PlanCore = Omit<RosterPlan, 'explanation'>;

/**
 * The summary is what a manager reads before sending a roster out, so it has
 * to be accurate about the two things they will be challenged on: how much is
 * covered, and whether the split of hours got fairer or worse.
 */
describe('PlanExplainerService', () => {
  const explainer = new PlanExplainerService(new ConfigService({}));

  const plan = (overrides: Partial<PlanCore> = {}): PlanCore => ({
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-08T00:00:00.000Z',
    locationIds: [],
    assignments: [],
    unfilled: [],
    metrics: {
      slotsTotal: 10,
      slotsFilled: 10,
      coverage: 1,
      hoursSpreadBefore: 6,
      hoursSpreadAfter: 4,
    },
    ...overrides,
  });

  const assignment = (name: string) => ({
    shiftId: 's1',
    staffId: 'u1',
    staffName: name,
    reason: 'because',
    weeklyHoursBefore: 0,
    premiumShiftsBefore: 0,
  });

  it('defaults to the rules-based writer with no model configured', async () => {
    const result = await explainer.explain(plan());
    expect(result.source).toBe('rules');
  });

  it('reports coverage as a percentage and as raw counts', async () => {
    const result = await explainer.explain(
      plan({
        assignments: [assignment('Sarah')],
        metrics: {
          slotsTotal: 10,
          slotsFilled: 7,
          coverage: 0.7,
          hoursSpreadBefore: 5,
          hoursSpreadAfter: 5,
        },
      }),
    );
    expect(result.summary).toContain('70%');
    expect(result.summary).toContain('7 of 10');
  });

  it('says plainly when nothing could be filled', async () => {
    const result = await explainer.explain(
      plan({
        assignments: [],
        metrics: {
          slotsTotal: 4,
          slotsFilled: 0,
          coverage: 0,
          hoursSpreadBefore: 3,
          hoursSpreadAfter: 3,
        },
      }),
    );
    expect(result.summary).toMatch(/no new assignments/i);
  });

  it('reports a narrowing spread as fairer', async () => {
    const result = await explainer.explain(
      plan({
        assignments: [assignment('Sarah')],
        metrics: {
          slotsTotal: 2,
          slotsFilled: 2,
          coverage: 1,
          hoursSpreadBefore: 8,
          hoursSpreadAfter: 3,
        },
      }),
    );
    expect(result.summary).toMatch(/more evenly shared/i);
    expect(result.summary).toContain('8.0h');
    expect(result.summary).toContain('3.0h');
  });

  it('admits when the plan made the split less even', async () => {
    // The honest case: sometimes the only eligible people are the busy ones,
    // and the summary must not spin that as a win.
    const result = await explainer.explain(
      plan({
        assignments: [assignment('Sarah')],
        metrics: {
          slotsTotal: 2,
          slotsFilled: 2,
          coverage: 1,
          hoursSpreadBefore: 2,
          hoursSpreadAfter: 7,
        },
      }),
    );
    expect(result.summary).toMatch(/less even/i);
  });

  it('treats a negligible change as unchanged rather than as an improvement', async () => {
    const result = await explainer.explain(
      plan({
        metrics: {
          slotsTotal: 2,
          slotsFilled: 2,
          coverage: 1,
          hoursSpreadBefore: 4.01,
          hoursSpreadAfter: 4.0,
        },
      }),
    );
    expect(result.summary).toMatch(/unchanged/i);
  });

  it('names the most common reason slots stayed open', async () => {
    const result = await explainer.explain(
      plan({
        unfilled: [
          {
            shiftId: 's9',
            shiftLabel: 'Brooklyn · bartender',
            remaining: 2,
            blockers: [
              { reason: 'lacks the required skill', staffCount: 5 },
              { reason: 'unavailable at that time', staffCount: 1 },
            ],
          },
        ],
        metrics: {
          slotsTotal: 6,
          slotsFilled: 4,
          coverage: 0.667,
          hoursSpreadBefore: 3,
          hoursSpreadAfter: 3,
        },
      }),
    );
    expect(result.summary).toContain('2 slots');
    expect(result.summary).toContain('lacks the required skill');
  });

  it('uses singular wording for a single slot', async () => {
    const result = await explainer.explain(
      plan({
        unfilled: [
          {
            shiftId: 's9',
            shiftLabel: 'Boston · server',
            remaining: 1,
            blockers: [{ reason: 'unavailable at that time', staffCount: 2 }],
          },
        ],
      }),
    );
    expect(result.summary).toContain('1 slot across 1 shift');
  });

  it('says there was nothing to plan for an empty range', async () => {
    // Not "100% covered": an empty week is unplanned, not fully staffed, and
    // conflating the two would tell a manager the opposite of the truth.
    const result = await explainer.explain(
      plan({
        metrics: {
          slotsTotal: 0,
          slotsFilled: 0,
          coverage: 0,
          hoursSpreadBefore: 0,
          hoursSpreadAfter: 0,
        },
      }),
    );
    expect(result.summary).toMatch(/nothing to plan/i);
    expect(result.summary).not.toContain('100%');
  });

  it('falls back to rules when a configured model fails', async () => {
    // narrate() rejects until a provider is wired; the plan must still return.
    const withKey = new PlanExplainerService(
      new ConfigService({ PLANNER_LLM_API_KEY: 'set-but-unwired' }),
    );
    const result = await withKey.explain(plan());
    expect(result.source).toBe('rules');
    expect(result.summary).not.toContain('No model provider');
  });
});
