import { SetMetadata } from '@nestjs/common';
import { IsPublic } from '@/shared/constants';

/**
 * Marks a route as reachable without a bearer token.
 *
 * JwtAuthGuard already looked for this metadata, but nothing ever set it —
 * the only way to expose a route was to omit the guard entirely, which is easy
 * to do by accident and invisible in review. Being explicit is safer.
 */
export const Public = () => SetMetadata(IsPublic, true);
