import { daysAhead, Fixtures, startApp, TestApp } from './support/harness';

type Swap = { id: string; status: string; targetAssignmentId: string | null };

describe('Swap and drop approval (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;

  beforeAll(async () => {
    t = await startApp();
    fx = new Fixtures(t);
  });

  afterAll(async () => {
    await t.app.close();
  });

  /** One location, one skill, its manager and two qualified staff. */
  async function crew() {
    const location = await fx.location();
    const skill = await fx.skill();
    const manager = await fx.user('manager', { manages: [location] });
    const staff = { certifiedAt: [location], skills: [skill] };
    const alice = await fx.user('staff', { ...staff, name: 'Alice' });
    const bob = await fx.user('staff', { ...staff, name: 'Bob' });
    return { location, skill, manager, alice, bob };
  }

  async function as(email: string) {
    const token = await fx.token(email);
    const auth = { Authorization: `Bearer ${token}` };
    return {
      get: (path: string) => t.http().get(`/api${path}`).set(auth),
      post: (path: string, body?: object) =>
        t
          .http()
          .post(`/api${path}`)
          .set(auth)
          .send(body ?? {}),
    };
  }

  async function holder(shiftId: string): Promise<string[]> {
    const rows = await t.prisma.shiftAssignment.findMany({
      where: { shiftId },
      select: { staffId: true },
    });
    return rows.map((r) => r.staffId);
  }

  it('approves an unclaimed drop and frees the slot', async () => {
    const c = await crew();
    const shift = await fx.shift(c.location, c.skill, daysAhead(5), 6);
    const mine = await fx.assign(shift.id, c.alice.id, c.manager.id);

    const alice = await as(c.alice.email);
    const drop = await alice
      .post('/swap-requests', { type: 'drop', requestingAssignmentId: mine.id })
      .expect(201);

    const manager = await as(c.manager.email);
    const res = await manager
      .post(`/swap-requests/${(drop.body as Swap).id}/approve`)
      .expect(201);

    expect((res.body as Swap).status).toBe('approved');
    expect(await holder(shift.id)).toEqual([]);
  });

  it('hands a claimed drop to the claimer and keeps the request', async () => {
    const c = await crew();
    const shift = await fx.shift(c.location, c.skill, daysAhead(5), 6);
    const mine = await fx.assign(shift.id, c.alice.id, c.manager.id);

    const alice = await as(c.alice.email);
    const drop = await alice
      .post('/swap-requests', { type: 'drop', requestingAssignmentId: mine.id })
      .expect(201);
    const id = (drop.body as Swap).id;

    const bob = await as(c.bob.email);
    await bob.post(`/swap-requests/${id}/claim`).expect(201);

    const manager = await as(c.manager.email);
    await manager.post(`/swap-requests/${id}/approve`).expect(201);

    expect(await holder(shift.id)).toEqual([c.bob.id]);
    const after = await alice.get(`/swap-requests/${id}`).expect(200);
    expect((after.body as Swap).status).toBe('approved');
  });

  it.each([
    ['on different days', 6],
    ['at the same time', 5],
  ])(
    'exchanges both shifts in a two-way swap (%s)',
    async (_label, secondDay) => {
      const c = await crew();
      const first = await fx.shift(c.location, c.skill, daysAhead(5), 6);
      const second = await fx.shift(
        c.location,
        c.skill,
        daysAhead(secondDay),
        6,
      );
      const aliceShift = await fx.assign(first.id, c.alice.id, c.manager.id);
      const bobShift = await fx.assign(second.id, c.bob.id, c.manager.id);

      const alice = await as(c.alice.email);
      const swap = await alice
        .post('/swap-requests', {
          type: 'swap',
          requestingAssignmentId: aliceShift.id,
          targetStaffId: c.bob.id,
          targetAssignmentId: bobShift.id,
        })
        .expect(201);
      const id = (swap.body as Swap).id;

      const bob = await as(c.bob.email);
      await bob.post(`/swap-requests/${id}/accept`).expect(201);

      const manager = await as(c.manager.email);
      const res = await manager
        .post(`/swap-requests/${id}/approve`)
        .expect(201);

      expect(await holder(first.id)).toEqual([c.bob.id]);
      expect(await holder(second.id)).toEqual([c.alice.id]);
      const approved = res.body as Swap;
      expect(approved.status).toBe('approved');
      const exchanged = await t.prisma.shiftAssignment.findUnique({
        where: { id: approved.targetAssignmentId! },
      });
      expect(exchanged).toMatchObject({
        shiftId: second.id,
        staffId: c.alice.id,
      });
    },
  );

  it('refuses approval from a manager of another location', async () => {
    const c = await crew();
    const elsewhere = await fx.location();
    const outsider = await fx.user('manager', { manages: [elsewhere] });
    const shift = await fx.shift(c.location, c.skill, daysAhead(5), 6);
    const mine = await fx.assign(shift.id, c.alice.id, c.manager.id);

    const alice = await as(c.alice.email);
    const drop = await alice
      .post('/swap-requests', { type: 'drop', requestingAssignmentId: mine.id })
      .expect(201);

    const other = await as(outsider.email);
    await other
      .post(`/swap-requests/${(drop.body as Swap).id}/approve`)
      .expect(403);
    expect(await holder(shift.id)).toEqual([c.alice.id]);
  });

  it('hides a swap request from unrelated staff', async () => {
    const c = await crew();
    const stranger = await fx.user('staff');
    const first = await fx.shift(c.location, c.skill, daysAhead(5), 6);
    const mine = await fx.assign(first.id, c.alice.id, c.manager.id);

    const alice = await as(c.alice.email);
    const swap = await alice
      .post('/swap-requests', {
        type: 'swap',
        requestingAssignmentId: mine.id,
        targetStaffId: c.bob.id,
      })
      .expect(201);
    const id = (swap.body as Swap).id;

    const other = await as(stranger.email);
    await other.get(`/swap-requests/${id}`).expect(403);
    const bob = await as(c.bob.email);
    await bob.get(`/swap-requests/${id}`).expect(200);
  });
});
