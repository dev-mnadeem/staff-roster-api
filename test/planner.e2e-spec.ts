import { daysAhead, Fixtures, startApp, TestApp } from './support/harness';

type Plan = {
  locationIds: string[];
  assignments: { shiftId: string; staffId: string }[];
  unfilled: {
    shiftId: string;
    blockers: { reason: string; staffCount: number }[];
  }[];
};

describe('Roster planner (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;
  const window = { from: daysAhead(2, 0), to: daysAhead(16, 0) };

  beforeAll(async () => {
    t = await startApp();
    fx = new Fixtures(t);
  });

  afterAll(async () => {
    await t.app.close();
  });

  async function plan(email: string, status: number, body: object = {}) {
    const token = await fx.token(email);
    const res = await t
      .http()
      .post('/api/planner/plan')
      .set('Authorization', `Bearer ${token}`)
      .send({
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        ...body,
      })
      .expect(status);
    return res.body as Plan;
  }

  it('keeps a manager to the locations they manage', async () => {
    const mine = await fx.location();
    const theirs = await fx.location('America/Los_Angeles');
    const skill = await fx.skill();
    const manager = await fx.user('manager', { manages: [mine] });
    const ownShift = await fx.shift(mine, skill, daysAhead(5), 6);
    const otherShift = await fx.shift(theirs, skill, daysAhead(5), 6);

    const body = await plan(manager.email, 200);
    const seen = [
      ...body.assignments.map((a) => a.shiftId),
      ...body.unfilled.map((u) => u.shiftId),
    ];
    expect(body.locationIds).toEqual([mine.id]);
    expect(seen).toContain(ownShift.id);
    expect(seen).not.toContain(otherShift.id);

    await plan(manager.email, 403, { locationIds: [theirs.id] });
  });

  it('never plans one person into two overlapping shifts', async () => {
    const location = await fx.location();
    const skill = await fx.skill();
    const manager = await fx.user('manager', { manages: [location] });
    const only = await fx.user('staff', {
      certifiedAt: [location],
      skills: [skill],
    });
    const first = await fx.shift(location, skill, daysAhead(6), 6);
    const second = await fx.shift(location, skill, daysAhead(6, 16), 6);

    const body = await plan(manager.email, 200);

    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].staffId).toBe(only.id);
    expect(body.unfilled.map((u) => u.shiftId)).toEqual(
      [first.id, second.id].filter((id) => id !== body.assignments[0].shiftId),
    );
    expect(body.unfilled[0].blockers).toContainEqual({
      reason: 'already working an overlapping shift',
      staffCount: 1,
    });
  });

  it('breaks an hours tie in favour of fewer premium shifts', async () => {
    const location = await fx.location();
    const skill = await fx.skill();
    const manager = await fx.user('manager', { manages: [location] });
    const staff = { certifiedAt: [location], skills: [skill] };
    const busyWeekends = await fx.user('staff', staff);
    const quietWeekends = await fx.user('staff', staff);

    // Equal hours already rostered; only one of them is a premium shift.
    const premium = await fx.shift(location, skill, daysAhead(3), 6);
    await t.prisma.shift.update({
      where: { id: premium.id },
      data: { isPremium: true },
    });
    const ordinary = await fx.shift(location, skill, daysAhead(4), 6);
    await fx.assign(premium.id, busyWeekends.id, manager.id);
    await fx.assign(ordinary.id, quietWeekends.id, manager.id);
    const open = await fx.shift(location, skill, daysAhead(8), 6);

    const body = await plan(manager.email, 200);

    const pick = body.assignments.find((a) => a.shiftId === open.id);
    expect(pick?.staffId).toBe(quietWeekends.id);
  });

  it('rejects an empty or oversized window', async () => {
    const admin = await fx.user('admin');
    await plan(admin.email, 400, {
      from: window.to.toISOString(),
      to: window.from.toISOString(),
    });
    await plan(admin.email, 400, {
      to: daysAhead(60, 0).toISOString(),
    });
  });
});
