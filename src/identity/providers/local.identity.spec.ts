import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { LocalIdentityProvider } from '@/identity/providers/local.identity';
import type { PrismaService } from '@/database/prisma.service';

/**
 * The self-hosted identity provider is the only thing standing between an
 * anonymous request and the whole API when Supabase is not configured, so its
 * behaviour is pinned here rather than assumed.
 */
describe('LocalIdentityProvider', () => {
  const SECRET = 'test-secret-that-is-long-enough-for-hs256';
  const USER_ID = '11111111-1111-4111-8111-111111111111';

  let prisma: {
    localIdentity: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    user: { findUnique: jest.Mock };
  };
  let provider: LocalIdentityProvider;

  const config = new ConfigService({ LOCAL_AUTH_SECRET: SECRET });

  beforeEach(() => {
    prisma = {
      localIdentity: { findUnique: jest.fn(), update: jest.fn() },
      user: { findUnique: jest.fn() },
    };
    provider = new LocalIdentityProvider(
      prisma as unknown as PrismaService,
      config,
    );
  });

  const seedIdentity = async (password = 'CoastalEats!2026') => {
    const passwordHash = await LocalIdentityProvider.hashPassword(password);
    prisma.localIdentity.findUnique.mockResolvedValue({
      id: USER_ID,
      email: 'manager@coastaleats.test',
      passwordHash,
      emailConfirmed: true,
      lastSignInAt: null,
    });
    prisma.localIdentity.update.mockResolvedValue({});
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, role: 'manager' });
  };

  describe('password hashing', () => {
    it('never stores the password itself', async () => {
      const hash = await LocalIdentityProvider.hashPassword('hunter2hunter2');
      expect(hash).not.toContain('hunter2hunter2');
      expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    });

    it('produces a different hash each time for the same password', async () => {
      // Per-user salt: identical passwords must not produce identical hashes,
      // or the store leaks which accounts share one.
      const a = await LocalIdentityProvider.hashPassword('same-password');
      const b = await LocalIdentityProvider.hashPassword('same-password');
      expect(a).not.toEqual(b);
    });
  });

  describe('signIn', () => {
    it('issues a token for correct credentials', async () => {
      await seedIdentity();
      const result = await provider.signIn(
        'manager@coastaleats.test',
        'CoastalEats!2026',
      );
      expect(result.accessToken.split('.')).toHaveLength(3);
    });

    it('rejects a wrong password', async () => {
      await seedIdentity();
      await expect(
        provider.signIn('manager@coastaleats.test', 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an unknown email with the same error as a wrong password', async () => {
      // Identical failures either way, so the response cannot be used to
      // enumerate which addresses have accounts.
      prisma.localIdentity.findUnique.mockResolvedValue(null);
      await expect(
        provider.signIn('nobody@example.test', 'CoastalEats!2026'),
      ).rejects.toThrow('Invalid email or password');
    });

    it('is case-insensitive on the email', async () => {
      await seedIdentity();
      await provider.signIn('MANAGER@CoastalEats.test', 'CoastalEats!2026');
      expect(prisma.localIdentity.findUnique).toHaveBeenCalledWith({
        where: { email: 'manager@coastaleats.test' },
      });
    });

    it('records the sign-in time', async () => {
      await seedIdentity();
      await provider.signIn('manager@coastaleats.test', 'CoastalEats!2026');
      expect(prisma.localIdentity.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: USER_ID } }),
      );
    });

    it('carries the profile role in the token', async () => {
      await seedIdentity();
      const { accessToken } = await provider.signIn(
        'manager@coastaleats.test',
        'CoastalEats!2026',
      );
      const principal = await provider.verifyToken(accessToken);
      expect(principal.role).toBe('manager');
      expect(principal.id).toBe(USER_ID);
    });
  });

  describe('verifyToken', () => {
    it('round-trips a token it issued', async () => {
      await seedIdentity();
      const { accessToken } = await provider.signIn(
        'manager@coastaleats.test',
        'CoastalEats!2026',
      );
      const principal = await provider.verifyToken(accessToken);
      expect(principal.email).toBe('manager@coastaleats.test');
    });

    it('rejects a token signed with a different secret', async () => {
      await seedIdentity();
      const { accessToken } = await provider.signIn(
        'manager@coastaleats.test',
        'CoastalEats!2026',
      );

      const other = new LocalIdentityProvider(
        prisma as unknown as PrismaService,
        new ConfigService({
          LOCAL_AUTH_SECRET: 'a-completely-different-secret',
        }),
      );
      await expect(other.verifyToken(accessToken)).rejects.toThrow();
    });

    it('rejects a malformed token', async () => {
      await expect(provider.verifyToken('not-a-jwt')).rejects.toThrow();
    });

    it('rejects an empty token', async () => {
      await expect(provider.verifyToken('')).rejects.toThrow();
    });
  });

  describe('getAccount', () => {
    it('returns the account for a known user', async () => {
      await seedIdentity();
      const account = await provider.getAccount(USER_ID);
      expect(account).toMatchObject({
        id: USER_ID,
        email: 'manager@coastaleats.test',
        emailConfirmed: true,
      });
    });

    it('returns null for an unknown user', async () => {
      prisma.localIdentity.findUnique.mockResolvedValue(null);
      expect(await provider.getAccount(USER_ID)).toBeNull();
    });
  });

  it('reports itself as self-hosted', () => {
    expect(provider.name).toBe('local');
    expect(provider.isExternal).toBe(false);
  });
});
