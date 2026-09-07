import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { Provides } from '@/shared/constants';
import type {
  AuthAccount,
  AuthPrincipal,
  IdentityProvider,
} from '@/identity/identity.types';

/**
 * Identity backed by Supabase Auth.
 *
 * Tokens are verified against Supabase's published JWKS, so this service never
 * holds a signing secret and never sees a password — the browser authenticates
 * with Supabase directly and presents the resulting JWT here.
 */
@Injectable()
export class SupabaseIdentityProvider implements IdentityProvider {
  readonly name = 'supabase';
  readonly isExternal = true;

  private readonly logger = new Logger(SupabaseIdentityProvider.name);
  private readonly issuer: string;

  constructor(
    @Inject(Provides.Supabase)
    private readonly supabase: SupabaseClient | null,
    @Inject(Provides.SupabaseJwks)
    private readonly jwks: JWTVerifyGetKey | null,
    config: ConfigService,
  ) {
    this.issuer = `${config.get<string>('SUPABASE_URL') ?? ''}/auth/v1`;
  }

  /** True when this provider has everything it needs to serve requests. */
  get isConfigured(): boolean {
    return Boolean(this.supabase && this.jwks);
  }

  async verifyToken(token: string): Promise<AuthPrincipal> {
    if (!this.jwks) {
      throw new Error('Supabase identity is not configured');
    }
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: 'authenticated',
    });

    return {
      id: payload.sub as string,
      email: payload.email as string | undefined,
      role: payload.role as string | undefined,
      appMetadata: payload.app_metadata as Record<string, unknown> | undefined,
      userMetadata: payload.user_metadata as
        | Record<string, unknown>
        | undefined,
    };
  }

  async getEmailMap(userIds?: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.supabase) return map;
    if (userIds && userIds.length === 0) return map;

    const wanted = userIds ? new Set(userIds) : null;
    const { data, error } = await this.supabase.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    if (error) {
      this.logger.error(`Failed to list auth users: ${error.message}`);
      return map;
    }
    for (const user of data.users) {
      if (user.email && (!wanted || wanted.has(user.id))) {
        map.set(user.id, user.email);
      }
    }
    return map;
  }

  async getAccount(userId: string): Promise<AuthAccount | null> {
    if (!this.supabase) return null;
    const { data, error } = await this.supabase.auth.admin.getUserById(userId);
    if (error || !data.user) {
      if (error) {
        this.logger.error(
          `Failed to fetch auth user ${userId}: ${error.message}`,
        );
      }
      return null;
    }
    return {
      id: data.user.id,
      email: data.user.email ?? '',
      emailConfirmed: Boolean(data.user.email_confirmed_at),
      lastSignInAt: data.user.last_sign_in_at ?? undefined,
    };
  }
}
