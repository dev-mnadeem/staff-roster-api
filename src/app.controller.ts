import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { PrismaService } from '@/database/prisma.service';
import { IDENTITY_PROVIDER } from '@/identity/identity.types';
import type { IdentityProvider } from '@/identity/identity.types';

class HealthDto {
  status!: 'ok' | 'degraded';
  database!: 'up' | 'down';
  identityProvider!: string;
  identityMode!: 'hosted' | 'self-hosted';
  uptimeSeconds!: number;
}

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
  ) {}

  /**
   * Readiness probe.
   *
   * Round-trips the database rather than returning a constant, so a container
   * with a broken connection string reports as degraded instead of being sent
   * traffic. Replaces the scaffolded "Hello World!" route.
   */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Service health, database, and identity mode' })
  @ApiOkResponse({ type: HealthDto })
  async getHealth(): Promise<HealthDto> {
    let database: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      identityProvider: this.identity.name,
      identityMode: this.identity.isExternal ? 'hosted' : 'self-hosted',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
