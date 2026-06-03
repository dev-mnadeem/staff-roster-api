import { Fixtures, startApp, TestApp } from './support/harness';

describe('Health and authentication (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;

  beforeAll(async () => {
    t = await startApp();
    fx = new Fixtures(t);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('reports the database and identity mode without a token', async () => {
    const res = await t.http().get('/api/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      database: 'up',
      identityProvider: 'local',
      identityMode: 'self-hosted',
    });
  });

  it('rejects a protected route without a bearer token', async () => {
    await t.http().get('/api/me').expect(401);
  });

  it('signs in a local account and returns its profile', async () => {
    const admin = await fx.user('admin', { name: 'E2E Admin' });
    const token = await fx.token(admin.email);

    const res = await t
      .http()
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({
      id: admin.id,
      email: admin.email,
      role: 'admin',
      displayName: 'E2E Admin',
    });
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const staff = await fx.user('staff');
    const wrong = await t
      .http()
      .post('/api/auth/login')
      .send({ email: staff.email, password: 'not-the-password' })
      .expect(401);
    const unknown = await t
      .http()
      .post('/api/auth/login')
      .send({ email: `nobody-${fx.tag}@e2e.test`, password: 'whatever' })
      .expect(401);
    const message = (res: { body: unknown }) =>
      (res.body as { message: string }).message;
    expect(message(wrong)).toBe(message(unknown));
  });
});
