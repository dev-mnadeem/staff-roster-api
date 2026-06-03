import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ShiftStatus, UserRole } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { PrismaService } from '@/database/prisma.service';
import { LocalIdentityProvider } from '@/identity/providers/local.identity';

/**
 * End-to-end tests run the real application against a migrated Postgres
 * (DATABASE_URL) with the self-hosted identity provider. Every test builds its
 * own locations, skills and people under a unique tag, so suites never depend
 * on the seed or on each other.
 */
export const TEST_PASSWORD = 'e2e-test-password';

export type TestApp = {
  app: INestApplication<App>;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
};

export async function startApp(): Promise<TestApp> {
  process.env.AUTH_PROVIDER = 'local';
  process.env.LOCAL_AUTH_SECRET ??= 'e2e-signing-secret-not-a-credential';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: ['error'],
  });
  configureApp(app);
  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
  };
}

const ALL_DAY_WEEK = [0, 1, 2, 3, 4, 5, 6];

export class Fixtures {
  readonly tag = randomUUID().slice(0, 8);
  private passwordHash?: string;

  constructor(private readonly t: TestApp) {}

  location(timezone = 'America/New_York') {
    return this.t.prisma.location.create({
      data: { name: `E2E ${this.tag} ${randomUUID().slice(0, 4)}`, timezone },
    });
  }

  skill() {
    return this.t.prisma.skill.create({
      data: { name: `e2e-${this.tag}-${randomUUID().slice(0, 4)}` },
    });
  }

  /**
   * A person with a login. Staff are certified at `certifiedAt`, hold
   * `skills`, and are available all day, every day, in each location's
   * timezone unless `available` is false.
   */
  async user(
    role: UserRole,
    opts: {
      name?: string;
      certifiedAt?: { id: string; timezone: string }[];
      skills?: { id: string }[];
      manages?: { id: string }[];
      available?: boolean;
    } = {},
  ) {
    const id = randomUUID();
    const email = `${role}-${this.tag}-${id.slice(0, 6)}@e2e.test`;
    this.passwordHash ??=
      await LocalIdentityProvider.hashPassword(TEST_PASSWORD);
    const prisma = this.t.prisma;

    await prisma.$executeRaw`
      INSERT INTO auth.users (id, email, email_confirmed_at)
      VALUES (${id}::uuid, ${email}, NOW())
    `;
    await prisma.localIdentity.create({
      data: { id, email, passwordHash: this.passwordHash },
    });
    await prisma.user.upsert({
      where: { id },
      create: { id, role, displayName: opts.name ?? email },
      update: { role, displayName: opts.name ?? email },
    });

    for (const location of opts.certifiedAt ?? []) {
      await prisma.staffCertification.create({
        data: { staffId: id, locationId: location.id },
      });
      if (opts.available !== false) {
        await prisma.availabilityRecurring.createMany({
          data: ALL_DAY_WEEK.map((weekday) => ({
            staffId: id,
            weekday,
            startTime: '00:00',
            endTime: '24:00',
            timezone: location.timezone,
          })),
          skipDuplicates: true,
        });
      }
    }
    for (const skill of opts.skills ?? []) {
      await prisma.staffSkill.create({
        data: { staffId: id, skillId: skill.id },
      });
    }
    for (const location of opts.manages ?? []) {
      await prisma.managerLocation.create({
        data: { managerId: id, locationId: location.id },
      });
    }
    return { id, email };
  }

  shift(
    location: { id: string },
    skill: { id: string },
    startAt: Date,
    hours: number,
    opts: { headcount?: number; status?: ShiftStatus } = {},
  ) {
    return this.t.prisma.shift.create({
      data: {
        locationId: location.id,
        requiredSkillId: skill.id,
        startAt,
        endAt: new Date(startAt.getTime() + hours * 3_600_000),
        headcount: opts.headcount ?? 1,
        status: opts.status ?? ShiftStatus.published,
      },
    });
  }

  assign(shiftId: string, staffId: string, assignedById: string) {
    return this.t.prisma.shiftAssignment.create({
      data: { shiftId, staffId, assignedById },
    });
  }

  async token(email: string): Promise<string> {
    const res = await this.t
      .http()
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }
}

/** Midnight UTC `days` from now, plus `hour` hours: safely past any cutoff. */
export function daysAhead(days: number, hour = 14): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour);
  return d;
}
