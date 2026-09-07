import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IDENTITY_PROVIDER, IdentityProvider } from '@/identity/identity.types';
import { LocalIdentityProvider } from '@/identity/providers/local.identity';
import { SupabaseIdentityProvider } from '@/identity/providers/supabase.identity';

/**
 * Chooses the identity provider once, at boot.
 *
 * Resolution order:
 *   1. AUTH_PROVIDER=local|supabase — explicit override, always wins.
 *   2. Supabase credentials present — use Supabase.
 *   3. otherwise — self-hosted local identity.
 *
 * Defaulting to local rather than failing is deliberate. Previously the
 * Supabase client threw during construction when credentials were absent, so a
 * fresh clone could not boot at all — not to serve a health check, not to run a
 * test. Everything above this layer sees one interface either way.
 */
@Global()
@Module({
  providers: [
    LocalIdentityProvider,
    SupabaseIdentityProvider,
    {
      provide: IDENTITY_PROVIDER,
      inject: [ConfigService, LocalIdentityProvider, SupabaseIdentityProvider],
      useFactory: (
        config: ConfigService,
        local: LocalIdentityProvider,
        supabase: SupabaseIdentityProvider,
      ): IdentityProvider => {
        const logger = new Logger('IdentityModule');
        const override = config.get<string>('AUTH_PROVIDER')?.toLowerCase();

        if (override === 'local') {
          logger.log('Identity: local (forced by AUTH_PROVIDER=local)');
          return local;
        }

        if (override === 'supabase') {
          if (!supabase.isConfigured) {
            throw new Error(
              'AUTH_PROVIDER=supabase but SUPABASE_URL / SUPABASE_SECRET_KEY ' +
                'are missing. Set them, or unset AUTH_PROVIDER to use local identity.',
            );
          }
          logger.log('Identity: supabase (forced by AUTH_PROVIDER=supabase)');
          return supabase;
        }

        if (supabase.isConfigured) {
          logger.log('Identity: supabase (credentials detected)');
          return supabase;
        }

        logger.warn(
          'Identity: local — no Supabase credentials found. Sign in with a ' +
            'seeded account (see the README). Set SUPABASE_URL and ' +
            'SUPABASE_SECRET_KEY to use the hosted provider instead.',
        );
        return local;
      },
    },
  ],
  exports: [IDENTITY_PROVIDER],
})
export class IdentityModule {}
