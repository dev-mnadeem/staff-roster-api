import { Fixtures, startApp, TestApp } from './support/harness';

describe('Availability validation (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let token: string;

  beforeAll(async () => {
    t = await startApp();
    fx = new Fixtures(t);
    const staff = await fx.user('staff');
    token = await fx.token(staff.email);
  });

  afterAll(async () => {
    await t.app.close();
  });

  const addWindow = (body: object) =>
    t
      .http()
      .post('/api/availability/me/recurring')
      .set('Authorization', `Bearer ${token}`)
      .send({ weekday: 5, timezone: 'America/New_York', ...body });

  it('accepts a window that runs to midnight', async () => {
    await addWindow({ startTime: '18:00', endTime: '24:00' }).expect(201);
  });

  it.each(['25:00', '29:59', '24:30', '7:00'])(
    'rejects the time %s',
    async (endTime) => {
      await addWindow({ startTime: '06:00', endTime }).expect(400);
    },
  );

  it('rejects a timezone that is not an IANA identifier', async () => {
    // A typo used to be stored and then silently ignored by the constraint
    // engine, which only reads windows in the shift location's timezone.
    await addWindow({
      startTime: '09:00',
      endTime: '17:00',
      timezone: 'America/NewYork',
    }).expect(400);
  });

  it('rejects a location with an unknown timezone', async () => {
    const admin = await fx.user('admin');
    const adminToken = await fx.token(admin.email);
    await t
      .http()
      .post('/api/locations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Bad tz ${fx.tag}`, timezone: 'Mars/Olympus' })
      .expect(400);
  });
});
