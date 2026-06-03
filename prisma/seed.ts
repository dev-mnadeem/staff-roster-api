import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { PrismaClient, ShiftStatus, SwapType, UserRole } from '@prisma/client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { fromZonedTime } from 'date-fns-tz';
import { config as loadEnv } from 'dotenv';

loadEnv();

const scryptAsync = promisify(scrypt);

// Supabase is optional. Without it the seed writes credentials into the
// application's own local_identities table, so the whole dataset — and a
// working login — can be created with nothing but a Postgres connection.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const USE_SUPABASE =
  process.env.AUTH_PROVIDER === 'supabase' ||
  (process.env.AUTH_PROVIDER !== 'local' &&
    Boolean(SUPABASE_URL) &&
    Boolean(SUPABASE_SECRET_KEY));

const SHARED_PASSWORD = process.env.SEED_PASSWORD ?? 'CoastalEats!2026';

type SeedUser = {
  email: string;
  displayName: string;
  role: UserRole;
  desiredHoursPerWeek?: number;
};

const SEED_USERS: SeedUser[] = [
  // Admin (corporate)
  {
    email: 'admin@coastaleats.test',
    displayName: 'Avery Admin',
    role: 'admin',
  },
  // Managers
  {
    email: 'east-manager@coastaleats.test',
    displayName: 'Maya East',
    role: 'manager',
  },
  {
    email: 'west-manager@coastaleats.test',
    displayName: 'Marco West',
    role: 'manager',
  },
  // Staff (mix of single-location + cross-tz)
  {
    email: 'sarah@coastaleats.test',
    displayName: 'Sarah Chen',
    role: 'staff',
    desiredHoursPerWeek: 32,
  },
  {
    email: 'john@coastaleats.test',
    displayName: 'John Rivera',
    role: 'staff',
    desiredHoursPerWeek: 30,
  },
  {
    email: 'maria@coastaleats.test',
    displayName: 'Maria Lopez',
    role: 'staff',
    desiredHoursPerWeek: 35,
  },
  {
    email: 'alex@coastaleats.test',
    displayName: 'Alex Kim',
    role: 'staff',
    desiredHoursPerWeek: 28,
  },
  {
    email: 'priya@coastaleats.test',
    displayName: 'Priya Patel',
    role: 'staff',
    desiredHoursPerWeek: 40,
  },
  {
    email: 'tom@coastaleats.test',
    displayName: 'Tom Nguyen',
    role: 'staff',
    desiredHoursPerWeek: 24,
  },
  // A second cohort. Six people covering four sites across two timezones is
  // thinner than any real operation, and it leaves the scheduler with no slack:
  // most shifts end up with exactly one possible candidate, so ranking by
  // fairness never gets to make a decision.
  {
    email: 'nina@coastaleats.test',
    displayName: 'Nina Alvarez',
    role: 'staff',
    desiredHoursPerWeek: 30,
  },
  {
    email: 'omar@coastaleats.test',
    displayName: 'Omar Haddad',
    role: 'staff',
    desiredHoursPerWeek: 36,
  },
  {
    email: 'lena@coastaleats.test',
    displayName: 'Lena Fischer',
    role: 'staff',
    desiredHoursPerWeek: 20,
  },
  {
    email: 'diego@coastaleats.test',
    displayName: 'Diego Ramos',
    role: 'staff',
    desiredHoursPerWeek: 32,
  },
  {
    email: 'yuki@coastaleats.test',
    displayName: 'Yuki Tanaka',
    role: 'staff',
    desiredHoursPerWeek: 28,
  },
  {
    email: 'raj@coastaleats.test',
    displayName: 'Raj Mehta',
    role: 'staff',
    desiredHoursPerWeek: 34,
  },
];

const SEED_LOCATIONS = [
  {
    name: 'Coastal Eats — Brooklyn',
    timezone: 'America/New_York',
    address: '123 Ocean Ave, Brooklyn NY',
  },
  {
    name: 'Coastal Eats — Boston',
    timezone: 'America/New_York',
    address: '88 Harbor St, Boston MA',
  },
  {
    name: 'Coastal Eats — Santa Monica',
    timezone: 'America/Los_Angeles',
    address: '500 Pier Ave, Santa Monica CA',
  },
  {
    name: 'Coastal Eats — Berkeley',
    timezone: 'America/Los_Angeles',
    address: '60 University Way, Berkeley CA',
  },
];

const SEED_SKILLS = ['server', 'bartender', 'line_cook', 'host'];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const supabase = USE_SUPABASE
    ? createClient(SUPABASE_URL!, SUPABASE_SECRET_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

  try {
    console.log('🌊 Seeding ShiftSync…');
    console.log(`  identity: ${supabase ? 'supabase' : 'local'}`);

    const userIdByEmail = supabase
      ? await seedUsers(supabase, prisma)
      : await seedLocalUsers(prisma);
    const locationIdByName = await seedLocations(prisma);
    const skillIdByName = await seedSkills(prisma);

    await seedManagerLocations(prisma, userIdByEmail, locationIdByName);
    await seedStaffCertifications(prisma, userIdByEmail, locationIdByName);
    await seedStaffSkills(prisma, userIdByEmail, skillIdByName);
    await seedAvailability(prisma, userIdByEmail);

    // Wipe time-varying data so reruns are deterministic.
    await prisma.swapRequest.deleteMany({});
    await prisma.shiftAssignment.deleteMany({});
    await prisma.shift.deleteMany({});
    await prisma.overtimeOverride.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.auditLog.deleteMany({});

    const shiftsByLabel = await seedShifts(
      prisma,
      locationIdByName,
      skillIdByName,
    );
    await seedAssignments(prisma, shiftsByLabel, userIdByEmail);
    await seedSwapsAndOverrides(prisma, shiftsByLabel, userIdByEmail);

    console.log('✓ Seed complete. Login credentials:');
    for (const user of SEED_USERS) {
      console.log(
        `  ${user.role.padEnd(7)} ${user.email.padEnd(40)} password=${SHARED_PASSWORD}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Creates users in the application's own database, for the self-hosted
 * identity provider. Mirrors seedUsers so both paths produce the same profiles
 * and the same credentials.
 */
async function seedLocalUsers(
  prisma: PrismaClient,
): Promise<Map<string, string>> {
  console.log('• Users (local identities)');
  const byEmail = new Map<string, string>();
  const passwordHash = await hashPassword(SHARED_PASSWORD);

  for (const seed of SEED_USERS) {
    const existing = await prisma.localIdentity.findUnique({
      where: { email: seed.email },
    });
    const id = existing?.id ?? randomUUID();

    // public.users.id carries a foreign key to auth.users(id) — a constraint
    // that exists in both the Supabase and local schemas — so the auth row has
    // to come first. Writing it also lets the same signup trigger fire locally
    // as in production, rather than diverging from it.
    await prisma.$executeRaw`
      INSERT INTO auth.users (id, email, email_confirmed_at, created_at, updated_at)
      VALUES (${id}::uuid, ${seed.email}, NOW(), NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    await prisma.localIdentity.upsert({
      where: { email: seed.email },
      create: { id, email: seed.email, passwordHash, emailConfirmed: true },
      // Re-hash on every run so the documented password always works.
      update: { passwordHash },
    });

    await prisma.user.upsert({
      where: { id },
      create: {
        id,
        role: seed.role,
        displayName: seed.displayName,
        desiredHoursPerWeek: seed.desiredHoursPerWeek,
      },
      update: {
        role: seed.role,
        displayName: seed.displayName,
        desiredHoursPerWeek: seed.desiredHoursPerWeek,
      },
    });

    if (!existing) console.log(`  + created ${seed.email}`);
    byEmail.set(seed.email, id);
  }
  return byEmail;
}

/** scrypt "salt:hash", matching LocalIdentityProvider.hashPassword. */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

async function seedUsers(
  supabase: SupabaseClient,
  prisma: PrismaClient,
): Promise<Map<string, string>> {
  console.log('• Users');
  const existing = await listAllAuthUsers(supabase);
  const byEmail = new Map<string, string>();

  for (const seed of SEED_USERS) {
    let id = existing.get(seed.email);
    if (!id) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: seed.email,
        password: SHARED_PASSWORD,
        email_confirm: true,
      });
      if (error || !data.user) {
        throw new Error(`createUser ${seed.email} failed: ${error?.message}`);
      }
      id = data.user.id;
      console.log(`  + created ${seed.email}`);
    } else {
      // Ensure a known password so README credentials always work.
      await supabase.auth.admin.updateUserById(id, {
        password: SHARED_PASSWORD,
      });
    }
    // Trigger created the profile row; upsert role/displayName.
    await prisma.user.upsert({
      where: { id },
      create: {
        id,
        role: seed.role,
        displayName: seed.displayName,
        desiredHoursPerWeek: seed.desiredHoursPerWeek,
      },
      update: {
        role: seed.role,
        displayName: seed.displayName,
        desiredHoursPerWeek: seed.desiredHoursPerWeek,
      },
    });
    byEmail.set(seed.email, id);
  }
  return byEmail;
}

async function listAllAuthUsers(
  supabase: SupabaseClient,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) throw new Error(`listUsers failed: ${error.message}`);
  for (const u of data.users) {
    if (u.email) map.set(u.email, u.id);
  }
  return map;
}

async function seedLocations(
  prisma: PrismaClient,
): Promise<Map<string, string>> {
  console.log('• Locations');
  const map = new Map<string, string>();
  for (const loc of SEED_LOCATIONS) {
    // No unique constraint on name; query first then create-or-update.
    const existing = await prisma.location.findFirst({
      where: { name: loc.name },
    });
    const row = existing
      ? await prisma.location.update({
          where: { id: existing.id },
          data: { timezone: loc.timezone, address: loc.address },
        })
      : await prisma.location.create({ data: loc });
    map.set(loc.name, row.id);
  }
  return map;
}

async function seedSkills(prisma: PrismaClient): Promise<Map<string, string>> {
  console.log('• Skills');
  const map = new Map<string, string>();
  for (const name of SEED_SKILLS) {
    const row = await prisma.skill.upsert({
      where: { name },
      create: { name },
      update: {},
    });
    map.set(name, row.id);
  }
  return map;
}

async function seedManagerLocations(
  prisma: PrismaClient,
  users: Map<string, string>,
  locations: Map<string, string>,
): Promise<void> {
  console.log('• Manager-locations');
  const east = users.get('east-manager@coastaleats.test')!;
  const west = users.get('west-manager@coastaleats.test')!;
  const brooklyn = locations.get('Coastal Eats — Brooklyn')!;
  const boston = locations.get('Coastal Eats — Boston')!;
  const santaMonica = locations.get('Coastal Eats — Santa Monica')!;
  const berkeley = locations.get('Coastal Eats — Berkeley')!;

  const pairs: Array<[string, string]> = [
    [east, brooklyn],
    [east, boston],
    [west, santaMonica],
    [west, berkeley],
  ];
  for (const [managerId, locationId] of pairs) {
    await prisma.managerLocation.upsert({
      where: { managerId_locationId: { managerId, locationId } },
      create: { managerId, locationId },
      update: {},
    });
  }
}

async function seedStaffCertifications(
  prisma: PrismaClient,
  users: Map<string, string>,
  locations: Map<string, string>,
): Promise<void> {
  console.log('• Staff certifications');
  const brooklyn = locations.get('Coastal Eats — Brooklyn')!;
  const boston = locations.get('Coastal Eats — Boston')!;
  const santaMonica = locations.get('Coastal Eats — Santa Monica')!;
  const berkeley = locations.get('Coastal Eats — Berkeley')!;

  // Coverage is deliberately uneven, but never empty: every location/skill
  // pairing that appears in a shift must have at least two eligible people.
  //
  // That floor matters. With a sparser matrix the scheduling features have
  // nothing to decide — the planner returns "nobody is eligible" for most
  // shifts and the fairness ranking never runs, which reads as broken rather
  // than as correct-but-unexercised.
  //
  // Kept from the original design: John spans both coasts, which is what makes
  // the cross-timezone rest and overtime rules observable.
  const certs: Array<[string, string[]]> = [
    ['sarah@coastaleats.test', [santaMonica, berkeley]],
    ['john@coastaleats.test', [santaMonica, brooklyn]],
    ['maria@coastaleats.test', [brooklyn, boston]],
    ['alex@coastaleats.test', [berkeley, boston, brooklyn]],
    ['priya@coastaleats.test', [brooklyn, boston]],
    ['tom@coastaleats.test', [santaMonica, berkeley]],
    ['nina@coastaleats.test', [brooklyn, boston]],
    ['omar@coastaleats.test', [santaMonica, berkeley]],
    ['lena@coastaleats.test', [brooklyn, boston]],
    ['diego@coastaleats.test', [santaMonica, berkeley]],
    ['yuki@coastaleats.test', [brooklyn, boston]],
    ['raj@coastaleats.test', [santaMonica, brooklyn]],
  ];
  for (const [email, locationIds] of certs) {
    const staffId = users.get(email)!;
    await prisma.staffCertification.deleteMany({ where: { staffId } });
    if (locationIds.length === 0) continue;
    await prisma.staffCertification.createMany({
      data: locationIds.map((locationId) => ({ staffId, locationId })),
      skipDuplicates: true,
    });
  }
}

async function seedStaffSkills(
  prisma: PrismaClient,
  users: Map<string, string>,
  skills: Map<string, string>,
): Promise<void> {
  console.log('• Staff skills');
  const server = skills.get('server')!;
  const bartender = skills.get('bartender')!;
  const lineCook = skills.get('line_cook')!;
  const host = skills.get('host')!;

  // Two skills each, so every shift has a real choice of who works it while
  // staying uneven enough for the fairness ranking to have something to say.
  const map: Array<[string, string[]]> = [
    ['sarah@coastaleats.test', [bartender, server]],
    ['john@coastaleats.test', [bartender, lineCook]],
    ['maria@coastaleats.test', [server, lineCook]],
    ['alex@coastaleats.test', [lineCook, server]],
    ['priya@coastaleats.test', [server, bartender]],
    ['tom@coastaleats.test', [lineCook, server]],
    ['nina@coastaleats.test', [bartender, server]],
    ['omar@coastaleats.test', [lineCook, bartender]],
    ['lena@coastaleats.test', [server, host]],
    ['diego@coastaleats.test', [server, lineCook]],
    ['yuki@coastaleats.test', [bartender, lineCook]],
    ['raj@coastaleats.test', [server, bartender]],
  ];
  for (const [email, skillIds] of map) {
    const staffId = users.get(email)!;
    await prisma.staffSkill.deleteMany({ where: { staffId } });
    if (skillIds.length === 0) continue;
    await prisma.staffSkill.createMany({
      data: skillIds.map((skillId) => ({ staffId, skillId })),
      skipDuplicates: true,
    });
  }
}

async function seedAvailability(
  prisma: PrismaClient,
  users: Map<string, string>,
): Promise<void> {
  console.log('• Availability');
  // Most staff: Mon-Fri 09:00-22:00 in their home tz.
  // John: cross-tz so we use ET as home tz to deliberately demo the Timezone Tangle.
  type AvailRow = { weekday: number; start: string; end: string; tz: string };
  const homeTzByEmail: Record<string, string> = {
    'sarah@coastaleats.test': 'America/Los_Angeles',
    'john@coastaleats.test': 'America/New_York',
    'maria@coastaleats.test': 'America/New_York',
    'alex@coastaleats.test': 'America/Los_Angeles',
    'priya@coastaleats.test': 'America/New_York',
    'tom@coastaleats.test': 'America/Los_Angeles',
    'nina@coastaleats.test': 'America/New_York',
    'omar@coastaleats.test': 'America/Los_Angeles',
    'lena@coastaleats.test': 'America/New_York',
    'diego@coastaleats.test': 'America/Los_Angeles',
    'yuki@coastaleats.test': 'America/New_York',
    'raj@coastaleats.test': 'America/New_York',
  };

  for (const [email, tz] of Object.entries(homeTzByEmail)) {
    const staffId = users.get(email)!;
    await prisma.availabilityRecurring.deleteMany({ where: { staffId } });
    await prisma.availabilityException.deleteMany({ where: { staffId } });

    const rows: AvailRow[] = [];
    // Mon..Fri 09:00-22:00
    for (let weekday = 1; weekday <= 5; weekday += 1) {
      rows.push({ weekday, start: '09:00', end: '22:00', tz });
    }
    // A weekend cohort. Only two people were available on Saturdays, which
    // meant the premium Fri/Sat shifts the fairness report is built around
    // could almost never be filled — the rotation had nobody to rotate between.
    const weekendStaff = [
      'sarah@coastaleats.test',
      'maria@coastaleats.test',
      'nina@coastaleats.test',
      'omar@coastaleats.test',
      'diego@coastaleats.test',
      'raj@coastaleats.test',
    ];
    if (weekendStaff.includes(email)) {
      rows.push({ weekday: 6, start: '12:00', end: '23:00', tz });
      rows.push({ weekday: 0, start: '12:00', end: '20:00', tz });
    }
    await prisma.availabilityRecurring.createMany({
      data: rows.map((r) => ({
        staffId,
        weekday: r.weekday,
        startTime: r.start,
        endTime: r.end,
        timezone: r.tz,
      })),
      skipDuplicates: true,
    });
  }

  // Tom takes a vacation day next Wednesday (whole-day blackout).
  const tomId = users.get('tom@coastaleats.test')!;
  const nextWed = nextWeekday(3); // 3 = Wednesday
  await prisma.availabilityException.create({
    data: {
      staffId: tomId,
      date: nextWed,
      isAvailable: false,
      timezone: 'America/Los_Angeles',
    },
  });
}

/**
 * Three weeks of completed shifts, so Analytics has something to report.
 *
 * Deliberately uneven: Sarah and Maria work more than Tom and Alex, and the
 * weekend premium slots are not shared equally. A fairness report over
 * perfectly balanced data would demonstrate nothing.
 */
function pastShiftSeeds(): ShiftSeed[] {
  const out: ShiftSeed[] = [];
  const pattern: Array<{
    locationName: string;
    skillName: string;
    startLocal: string;
    endLocal: string;
    weekday: number;
  }> = [
    {
      locationName: 'Coastal Eats — Brooklyn',
      skillName: 'server',
      startLocal: '11:00',
      endLocal: '19:00',
      weekday: 1,
    },
    {
      locationName: 'Coastal Eats — Brooklyn',
      skillName: 'bartender',
      startLocal: '17:00',
      endLocal: '23:00',
      weekday: 5,
    },
    {
      locationName: 'Coastal Eats — Boston',
      skillName: 'line_cook',
      startLocal: '10:00',
      endLocal: '18:00',
      weekday: 3,
    },
    {
      locationName: 'Coastal Eats — Santa Monica',
      skillName: 'server',
      startLocal: '17:00',
      endLocal: '23:00',
      weekday: 6,
    },
    {
      locationName: 'Coastal Eats — Berkeley',
      skillName: 'line_cook',
      startLocal: '12:00',
      endLocal: '20:00',
      weekday: 4,
    },
  ];

  for (let week = 1; week <= 3; week++) {
    for (const [index, slot] of pattern.entries()) {
      // Walk back whole weeks, then to the weekday within that week.
      const today = new Date();
      const offsetToWeekday = slot.weekday - today.getDay();
      const dayOffset = offsetToWeekday - week * 7;
      out.push({
        label: `past-w${week}-${index}`,
        locationName: slot.locationName,
        skillName: slot.skillName,
        dayOffset,
        startLocal: slot.startLocal,
        endLocal: slot.endLocal,
        headcount: 2,
        publish: true,
      });
    }
  }
  return out;
}

type ShiftSeed = {
  label: string;
  locationName: string;
  skillName: string;
  // dayOffset is days from today (in shift location's local date).
  dayOffset: number;
  startLocal: string; // "HH:MM"
  endLocal: string;
  headcount: number;
  publish: boolean;
};

async function seedShifts(
  prisma: PrismaClient,
  locations: Map<string, string>,
  skills: Map<string, string>,
): Promise<Map<string, string>> {
  console.log('• Shifts');
  // Two bands of data, for two different jobs.
  //
  // Forward-looking shifts drive the scheduling views: drafts to publish,
  // mixed timezones, premium (Fri/Sat 17:00+) slots, and back-to-back days
  // that trip the overtime and consecutive-day rules.
  //
  // Backward-looking shifts exist because Analytics reports on the *previous*
  // four weeks. Seeding only future work left every chart reading zero hours
  // and a large negative variance on a fresh install — the flagship screen
  // looked broken when it was merely empty.
  const seeds: ShiftSeed[] = [
    ...pastShiftSeeds(),
    // East coast
    {
      label: 'bk-mon-bar',
      locationName: 'Coastal Eats — Brooklyn',
      skillName: 'bartender',
      dayOffset: 3,
      startLocal: '17:00',
      endLocal: '23:00',
      headcount: 2,
      publish: true,
    },
    {
      label: 'bk-tue-svr',
      locationName: 'Coastal Eats — Brooklyn',
      skillName: 'server',
      dayOffset: 4,
      startLocal: '11:00',
      endLocal: '19:00',
      headcount: 3,
      publish: true,
    },
    {
      label: 'bk-fri-bar',
      locationName: 'Coastal Eats — Brooklyn',
      skillName: 'bartender',
      dayOffset: 7,
      startLocal: '17:00',
      endLocal: '23:30',
      headcount: 2,
      publish: true,
    }, // premium
    {
      label: 'bo-thu-cook',
      locationName: 'Coastal Eats — Boston',
      skillName: 'line_cook',
      dayOffset: 6,
      startLocal: '10:00',
      endLocal: '18:00',
      headcount: 2,
      publish: false,
    },
    {
      label: 'bo-sat-svr',
      locationName: 'Coastal Eats — Boston',
      skillName: 'server',
      dayOffset: 8,
      startLocal: '17:30',
      endLocal: '23:30',
      headcount: 4,
      publish: true,
    }, // premium
    // West coast
    {
      label: 'sm-mon-cook',
      locationName: 'Coastal Eats — Santa Monica',
      skillName: 'line_cook',
      dayOffset: 3,
      startLocal: '11:00',
      endLocal: '19:00',
      headcount: 2,
      publish: true,
    },
    {
      label: 'sm-fri-bar',
      locationName: 'Coastal Eats — Santa Monica',
      skillName: 'bartender',
      dayOffset: 7,
      startLocal: '17:00',
      endLocal: '23:00',
      headcount: 2,
      publish: true,
    }, // premium
    {
      label: 'sm-sat-svr',
      locationName: 'Coastal Eats — Santa Monica',
      skillName: 'server',
      dayOffset: 8,
      startLocal: '17:00',
      endLocal: '23:00',
      headcount: 3,
      publish: true,
    }, // premium
    {
      label: 'be-wed-cook',
      locationName: 'Coastal Eats — Berkeley',
      skillName: 'line_cook',
      dayOffset: 5,
      startLocal: '12:00',
      endLocal: '20:00',
      headcount: 2,
      publish: false,
    },
    // A draft "open shift" Sunday night for the chaos scenario.
    {
      label: 'bk-sun-svr',
      locationName: 'Coastal Eats — Brooklyn',
      skillName: 'server',
      dayOffset: 9,
      startLocal: '19:00',
      endLocal: '23:00',
      headcount: 1,
      publish: false,
    },
  ];

  const map = new Map<string, string>();
  for (const seed of seeds) {
    const locationId = locations.get(seed.locationName)!;
    const requiredSkillId = skills.get(seed.skillName)!;
    const tz = SEED_LOCATIONS.find(
      (l) => l.name === seed.locationName,
    )!.timezone;
    const startAt = localToUtc(
      daysFromToday(seed.dayOffset),
      seed.startLocal,
      tz,
    );
    const endAt = localToUtc(daysFromToday(seed.dayOffset), seed.endLocal, tz);
    const created = await prisma.shift.create({
      data: {
        locationId,
        requiredSkillId,
        startAt,
        endAt,
        headcount: seed.headcount,
        isPremium: isPremium(startAt, tz),
        status: seed.publish ? ShiftStatus.published : ShiftStatus.draft,
        publishedAt: seed.publish ? new Date() : null,
      },
    });
    map.set(seed.label, created.id);
  }
  return map;
}

async function seedAssignments(
  prisma: PrismaClient,
  shifts: Map<string, string>,
  users: Map<string, string>,
): Promise<void> {
  console.log('• Assignments');
  const eastMgr = users.get('east-manager@coastaleats.test')!;
  const westMgr = users.get('west-manager@coastaleats.test')!;

  type Pick = { shift: string; staffEmail: string; assigner: string };
  const picks: Pick[] = [
    // Brooklyn
    {
      shift: 'bk-mon-bar',
      staffEmail: 'john@coastaleats.test',
      assigner: eastMgr,
    },
    {
      shift: 'bk-tue-svr',
      staffEmail: 'maria@coastaleats.test',
      assigner: eastMgr,
    },
    {
      shift: 'bk-tue-svr',
      staffEmail: 'priya@coastaleats.test',
      assigner: eastMgr,
    },
    {
      shift: 'bk-fri-bar',
      staffEmail: 'john@coastaleats.test',
      assigner: eastMgr,
    },
    // Boston
    {
      shift: 'bo-sat-svr',
      staffEmail: 'maria@coastaleats.test',
      assigner: eastMgr,
    },
    {
      shift: 'bo-sat-svr',
      staffEmail: 'priya@coastaleats.test',
      assigner: eastMgr,
    },
    // Santa Monica
    {
      shift: 'sm-mon-cook',
      staffEmail: 'tom@coastaleats.test',
      assigner: westMgr,
    },
    {
      shift: 'sm-fri-bar',
      staffEmail: 'sarah@coastaleats.test',
      assigner: westMgr,
    }, // premium for Sarah
    {
      shift: 'sm-sat-svr',
      staffEmail: 'sarah@coastaleats.test',
      assigner: westMgr,
    }, // premium #2 for Sarah
  ];

  // Historical coverage. The rotation is uneven on purpose so the fairness
  // and variance reports have a real distribution to show.
  const pastRoster = [
    ['sarah@coastaleats.test', 'john@coastaleats.test'],
    ['maria@coastaleats.test', 'sarah@coastaleats.test'],
    ['priya@coastaleats.test', 'maria@coastaleats.test'],
    ['sarah@coastaleats.test', 'tom@coastaleats.test'],
    ['alex@coastaleats.test', 'maria@coastaleats.test'],
  ];
  for (let week = 1; week <= 3; week++) {
    for (let index = 0; index < pastRoster.length; index++) {
      const label = `past-w${week}-${index}`;
      if (!shifts.has(label)) continue;
      const assigner = index >= 3 ? westMgr : eastMgr;
      for (const staffEmail of pastRoster[index]) {
        picks.push({ shift: label, staffEmail, assigner });
      }
    }
  }

  for (const pick of picks) {
    const shiftId = shifts.get(pick.shift)!;
    const staffId = users.get(pick.staffEmail)!;
    try {
      await prisma.shiftAssignment.create({
        data: { shiftId, staffId, assignedById: pick.assigner },
      });
    } catch (error) {
      // Ignore EXCLUDE-constraint failures from intentionally tight seed times.
      console.warn(
        `  ! skipped ${pick.staffEmail} → ${pick.shift}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function seedSwapsAndOverrides(
  prisma: PrismaClient,
  shifts: Map<string, string>,
  users: Map<string, string>,
): Promise<void> {
  console.log('• Swaps + overrides');

  // Open drop request: Tom drops his Santa Monica Monday cook shift.
  const tomId = users.get('tom@coastaleats.test')!;
  const tomAssignment = await prisma.shiftAssignment.findFirst({
    where: { staffId: tomId, shiftId: shifts.get('sm-mon-cook') },
  });
  if (tomAssignment) {
    const tomShift = await prisma.shift.findUnique({
      where: { id: tomAssignment.shiftId },
    });
    await prisma.swapRequest.create({
      data: {
        type: SwapType.drop,
        requestingAssignmentId: tomAssignment.id,
        requesterId: tomId,
        expiresAt: tomShift
          ? new Date(tomShift.startAt.getTime() - 24 * 60 * 60 * 1000)
          : null,
      },
    });
  }

  // Pending swap: John (Brooklyn Friday bartender) → Sarah
  const johnId = users.get('john@coastaleats.test')!;
  const sarahId = users.get('sarah@coastaleats.test')!;
  const johnAssignment = await prisma.shiftAssignment.findFirst({
    where: { staffId: johnId, shiftId: shifts.get('bk-fri-bar') },
  });
  if (johnAssignment) {
    await prisma.swapRequest.create({
      data: {
        type: SwapType.swap,
        requestingAssignmentId: johnAssignment.id,
        requesterId: johnId,
        targetStaffId: sarahId,
      },
    });
  }

  // 7th-day override granted to Sarah for next Saturday so the demo has a
  // pre-existing override row to surface in the UI.
  const adminId = users.get('admin@coastaleats.test')!;
  const nextSat = nextWeekday(6);
  await prisma.overtimeOverride.create({
    data: {
      staffId: sarahId,
      effectiveDate: nextSat,
      reason: 'Approved 7th-day cover for Brooklyn launch event',
      approvedById: adminId,
    },
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function daysFromToday(offset: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
}

/** Build a UTC Date for a wall-clock time on a given date in the given tz. */
function localToUtc(date: Date, hhmm: string, tz: string): Date {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const local = `${y}-${m}-${d}T${hhmm}:00`;
  return fromZonedTime(local, tz);
}

function isPremium(startAt: Date, tz: string): boolean {
  const local = new Date(startAt.toLocaleString('en-US', { timeZone: tz }));
  const day = local.getDay();
  const hour = local.getHours();
  return (day === 5 || day === 6) && hour >= 17;
}

function nextWeekday(target: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const diff = (target - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
  return d;
}

main().catch((error) => {
  console.error('✗ Seed failed:', error);
  process.exit(1);
});
