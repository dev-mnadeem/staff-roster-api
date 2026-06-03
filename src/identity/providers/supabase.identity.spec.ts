import type { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JWTVerifyGetKey } from 'jose';
import { SupabaseIdentityProvider } from '@/identity/providers/supabase.identity';

/** A Supabase admin client whose listUsers serves `total` users in pages. */
function fakeClient(total: number) {
  const users = Array.from({ length: total }, (_, i) => ({
    id: `user-${i}`,
    email: `person${i}@example.test`,
  }));
  const listUsers = jest.fn(
    ({ page, perPage }: { page: number; perPage: number }) =>
      Promise.resolve({
        data: { users: users.slice((page - 1) * perPage, page * perPage) },
        error: null,
      }),
  );
  const client = { auth: { admin: { listUsers } } };
  return { client: client as unknown as SupabaseClient, listUsers };
}

function provider(client: SupabaseClient) {
  const config = {
    get: () => 'https://project.supabase.example',
  } as unknown as ConfigService;
  const jwks = (() => undefined) as unknown as JWTVerifyGetKey;
  return new SupabaseIdentityProvider(client, jwks, config);
}

describe('SupabaseIdentityProvider.getEmailMap', () => {
  it('reads every page of users, not just the first', async () => {
    const { client, listUsers } = fakeClient(2500);

    const map = await provider(client).getEmailMap();

    expect(map.size).toBe(2500);
    expect(map.get('user-2499')).toBe('person2499@example.test');
    expect(listUsers).toHaveBeenCalledTimes(3);
  });

  it('stops paging once every requested id is found', async () => {
    const { client, listUsers } = fakeClient(2500);

    const map = await provider(client).getEmailMap(['user-3', 'user-10']);

    expect([...map.keys()].sort()).toEqual(['user-10', 'user-3']);
    expect(listUsers).toHaveBeenCalledTimes(1);
  });

  it('skips the API when no ids are requested', async () => {
    const { client, listUsers } = fakeClient(10);

    expect((await provider(client).getEmailMap([])).size).toBe(0);
    expect(listUsers).not.toHaveBeenCalled();
  });
});
