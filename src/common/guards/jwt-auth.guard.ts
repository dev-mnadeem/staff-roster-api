import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IsPublic } from '@/shared/constants';
import { IDENTITY_PROVIDER } from '@/identity/identity.types';
import type { IdentityProvider } from '@/identity/identity.types';
import type { AuthenticatedUser } from '@/types/auth';

/** The minimum shape this guard reads from, and writes to, the request. */
type AuthedRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
};

/**
 * Authenticates a request by verifying its bearer token.
 *
 * Verification is delegated to whichever IdentityProvider was selected at boot,
 * so this guard is identical whether tokens come from Supabase or from the
 * self-hosted provider.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IsPublic, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      request.user = await this.identity.verifyToken(token);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid token';
      this.logger.warn(`JWT verification failed: ${message}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(request: AuthedRequest): string | undefined {
    const header = request.headers.authorization;
    if (typeof header !== 'string') return undefined;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
    return token;
  }
}
