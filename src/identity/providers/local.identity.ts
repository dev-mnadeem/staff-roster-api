import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';
import { PrismaService } from '@/database/prisma.service';
import type {
  AuthAccount,
  AuthPrincipal,
  IdentityProvider,
} from '@/identity/identity.types';

const scryptAsync = promisify(scrypt);

const TOKEN_TTL = '12h';
const ISSUER = 'shiftsync-local';
const AUDIENCE = 'authenticated';

/**
 * Self-hosted identity, used when no Supabase project is configured.
 *
 * Credentials live in the application's own database and tokens are signed
 * locally with HS256. This exists so the project can be cloned, started and
 * evaluated — and so the API can be tested — without provisioning a hosted
 * identity service. The token shape matches the Supabase one exactly, so every
 * guard, controller and client above this layer is unchanged.
 *
 * Passwords are stored as scrypt hashes with a per-user salt and compared in
 * constant time. scrypt is deliberately chosen over a fast hash: it is memory-
 * hard, and it ships in Node's standard library, so this adds no dependency.
 */
@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  readonly name = 'local';
  readonly isExternal = false;

  private readonly logger = new Logger(LocalIdentityProvider.name);
  private readonly secret: Uint8Array;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const configured = config.get<string>('LOCAL_AUTH_SECRET');
    if (!configured) {
      this.logger.warn(
        'LOCAL_AUTH_SECRET is not set — signing with an ephemeral secret. ' +
          'Tokens will be invalidated on restart. Set it for a stable dev setup.',
      );
    }
    this.secret = new TextEncoder().encode(
      configured ?? randomBytes(32).toString('hex'),
    );
  }

  async verifyToken(token: string): Promise<AuthPrincipal> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return {
      id: payload.sub as string,
      email: payload.email as string | undefined,
      role: payload.role as string | undefined,
    };
  }

  async getEmailMap(userIds?: string[]): Promise<Map<string, string>> {
    if (userIds && userIds.length === 0) return new Map();
    const rows = await this.prisma.localIdentity.findMany({
      where: userIds ? { id: { in: userIds } } : undefined,
      select: { id: true, email: true },
    });
    return new Map(rows.map((row) => [row.id, row.email]));
  }

  async getAccount(userId: string): Promise<AuthAccount | null> {
    const identity = await this.prisma.localIdentity.findUnique({
      where: { id: userId },
    });
    if (!identity) return null;
    return {
      id: identity.id,
      email: identity.email,
      emailConfirmed: identity.emailConfirmed,
      lastSignInAt: identity.lastSignInAt?.toISOString(),
    };
  }

  async signIn(
    email: string,
    password: string,
  ): Promise<{ accessToken: string }> {
    const identity = await this.prisma.localIdentity.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Verify against a dummy hash even when the account is unknown, so the
    // response time does not reveal which addresses exist.
    const stored =
      identity?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const matches = await this.verifyPassword(password, stored);

    if (!identity || !matches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.prisma.localIdentity.update({
      where: { id: identity.id },
      data: { lastSignInAt: new Date() },
    });

    const profile = await this.prisma.user.findUnique({
      where: { id: identity.id },
    });

    const accessToken = await new SignJWT({
      email: identity.email,
      role: profile?.role ?? 'staff',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(identity.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .sign(this.secret);

    return { accessToken };
  }

  /** `salt:hash`, both hex. Exposed for the seed script. */
  static async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derived = (await scryptAsync(password, salt, 64)) as Buffer;
    return `${salt}:${derived.toString('hex')}`;
  }

  private async verifyPassword(
    password: string,
    stored: string,
  ): Promise<boolean> {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    try {
      const derived = (await scryptAsync(password, salt, 64)) as Buffer;
      const expected = Buffer.from(hash, 'hex');
      if (expected.length !== derived.length) return false;
      return timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }
}
