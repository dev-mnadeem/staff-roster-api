import { daysAhead, Fixtures, startApp, TestApp } from './support/harness';

describe('Assignments and headcount (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;

  beforeAll(async () => {
    t = await startApp();
    fx = new Fixtures(t);
  });

  afterAll(async () => {
    await t.app.close();
  });

  async function setup(headcount: number) {
    const location = await fx.location();
    const skill = await fx.skill();
    const manager = await fx.user('manager', { manages: [location] });
    const staff = await Promise.all(
      [1, 2, 3].map(() =>
        fx.user('staff', { certifiedAt: [location], skills: [skill] }),
      ),
    );
    const shift = await fx.shift(location, skill, daysAhead(5), 6, {
      headcount,
    });
    const token = await fx.token(manager.email);
    const assign = (staffId: string) =>
      t
        .http()
        .post(`/api/shifts/${shift.id}/assignments`)
        .set('Authorization', `Bearer ${token}`)
        .send({ staffId });
    return { shift, staff, token, assign };
  }

  it('fills a shift up to its headcount and no further', async () => {
    const { shift, staff, assign } = await setup(2);

    await assign(staff[0].id).expect(201);
    await assign(staff[1].id).expect(201);
    const full = await assign(staff[2].id).expect(409);

    expect((full.body as { message: string }).message).toMatch(
      /fully staffed \(2 of 2\)/,
    );
    expect(
      await t.prisma.shiftAssignment.count({ where: { shiftId: shift.id } }),
    ).toBe(2);
  });

  it('lets concurrent requests take only the open slots', async () => {
    const { shift, staff, assign } = await setup(1);

    const results = await Promise.all(staff.map((s) => assign(s.id)));

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(
      await t.prisma.shiftAssignment.count({ where: { shiftId: shift.id } }),
    ).toBe(1);
  });

  it('refuses to lower headcount below the people assigned', async () => {
    const { shift, staff, token, assign } = await setup(2);
    await assign(staff[0].id).expect(201);
    await assign(staff[1].id).expect(201);

    await t
      .http()
      .patch(`/api/shifts/${shift.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ headcount: 1, version: shift.version })
      .expect(400);
  });
});
