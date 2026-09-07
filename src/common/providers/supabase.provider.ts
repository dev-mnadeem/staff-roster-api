import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { Provides } from '@/shared/constants';

/**
 * Both providers resolve to null when Supabase is not configured.
 *
 * They used to throw during module construction, which meant a clone without a
 * hosted Supabase project could not start the application at all — not to serve
 * a health check, not to run a test. Returning null lets the identity layer
 * fall back to the self-hosted provider instead, and the only code that reads
 * these tokens is SupabaseIdentityProvider, which is only selected when they
 * are non-null.
 */
export const SupabaseClientProvider: Provider = {
  provide: Provides.Supabase,
  useFactory: (configService: ConfigService): SupabaseClient | null => {
    const url = configService.get<string>('SUPABASE_URL');
    const secret = configService.get<string>('SUPABASE_SECRET_KEY');
    if (!url || !secret) {
      new Logger('SupabaseProvider').log(
        'Supabase not configured; the admin client is unavailable.',
      );
      return null;
    }
    return createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  },
  inject: [ConfigService],
};

export const SupabaseJwksProvider: Provider = {
  provide: Provides.SupabaseJwks,
  useFactory: (configService: ConfigService): JWTVerifyGetKey | null => {
    const url = configService.get<string>('SUPABASE_URL');
    if (!url) return null;
    return createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  },
  inject: [ConfigService],
};
