# ShiftSync API

Backend for a staff scheduling app built around a restaurant group with four locations in two timezones. Managers create shifts, assign staff, handle swaps and availability, and can ask the planner to suggest who should fill open slots. Every assignment, whoever or whatever proposes it, goes through one constraint engine, so the roster cannot quietly break a labour rule. Built with NestJS, Prisma and PostgreSQL.

The web frontend lives in a separate `shiftsync-fe` repo; this API runs and is fully usable without it.

## What's in it

- Shifts with draft/published states, optimistic locking (`version`) and a 48-hour publish cutoff
- Assignments checked by a constraint engine that reports every failed rule at once instead of the first one, and that never lets a shift take more people than its headcount
- Staff availability as weekly windows plus one-off exceptions, each in a named timezone
- Swap and drop requests: a peer accepts a swap, or anyone qualified claims a drop, and a manager approves. Approval re-runs the engine for everyone who gains a shift, and a two-way swap exchanges both shifts
- A roster planner (`POST /api/planner/plan`) that proposes staff for open slots. It only suggests; nothing is written
- Fairness and overtime analytics, an audit log with CSV export, in-app notifications with a simulated email channel, and an "on duty now" view
- Admin, manager and staff roles; managers only see and change the locations they manage
- Auth through Supabase, or a built-in local provider when no Supabase credentials are set

## How a request flows

```mermaid
flowchart LR
  client[Web app or API client] -->|Bearer token| guard[JwtAuthGuard]
  guard --> idp{Identity provider}
  idp -->|no Supabase keys| local[Local: scrypt + HS256]
  idp -->|keys set| supa[Supabase JWKS]
  guard --> roles[RolesGuard: role from the database]
  roles --> svc[Feature services]
  svc --> scope[LocationScopeService: which locations may this user touch]
  svc --> engine[ConstraintEngine]
  planner[RosterPlanner] --> engine
  svc --> db[(PostgreSQL)]
  planner --> db
  db --- excl[EXCLUDE constraint: no overlapping assignments per person]
```

The role in a token is never trusted: `RolesGuard` and the scope service read it from the `users` table on every request. The database adds the last line of defence: an `EXCLUDE USING gist` constraint on each person's shift ranges, maintained by triggers, rejects a double booking even when two managers race each other.

## Scheduling rules

All of them live in `src/constraints/constraint-engine.ts`, with thresholds in `src/shared/constants.ts`.

| Rule | Blocks | Warns |
| --- | --- | --- |
| Certified at the shift's location | always | |
| Has the shift's required skill | always | |
| Available for the whole shift (overnight shifts are checked on both days) | always | |
| No overlapping shift | always | |
| Rest between shifts | under 10 hours | |
| Hours in one day | over 12 | over 8 |
| Hours in the week (Sunday to Saturday, location time) | | over 35 |
| Consecutive days worked, counted both ways from the new shift | 7th day, unless a manager granted an override for that date | 6th day |

Days and weeks are bucketed in each location's own timezone. A recurring availability window only applies to shifts at locations in the same timezone, so someone certified on both coasts keeps a set of windows for each. Windows can't cross midnight: enter Friday 18:00-24:00 and Saturday 00:00-02:00 instead.

A shift is premium when it starts at or after 17:00 on a Friday or Saturday, local time. Premium counts feed the fairness report and the planner's tie-break.

## Getting started

### Docker Compose

```bash
docker compose up --build
```

This starts PostgreSQL and the API, applies migrations and, on first start, seeds a demo week. Later restarts keep your data.

- API: http://localhost:4000/api
- Swagger UI: http://localhost:4000/api/docs
- PostgreSQL: `localhost:5436` (user, password and database are all `shiftsync`)

To include the web frontend, clone `shiftsync-fe` next to this repo and add the profile; it is served on http://localhost:3200:

```bash
docker compose --profile web up --build
```

To reset the demo data, run the seed again without the "only if empty" guard:

```bash
docker compose exec api npm run seed:prod
```

### Without Docker

You need Node 22 (see `.nvmrc`) and a PostgreSQL database. Apply the auth schema stub once, since a few migrations expect objects that Supabase normally provides:

```bash
psql "$DATABASE_URL" -f docker/00-auth-schema.sql
npm ci
cp .env.example .env   # then point DATABASE_URL and DIRECT_URL at your database
npx prisma migrate deploy
npm run seed
npm run start:dev
```

The API listens on port 4000 by default.

### Demo accounts

Every seeded account uses the password `CoastalEats!2026` (set by `SEED_PASSWORD`). Emails use the reserved `.test` domain.

| Account | Role | Scope |
| --- | --- | --- |
| `admin@coastaleats.test` | admin | everything |
| `east-manager@coastaleats.test` | manager | Brooklyn and Boston (New York time) |
| `west-manager@coastaleats.test` | manager | Santa Monica and Berkeley (Los Angeles time) |
| `sarah@`, `john@`, `maria@`, `alex@`, `priya@`, `tom@`, `nina@`, `omar@`, `lena@`, `diego@`, `yuki@`, `raj@coastaleats.test` | staff | the locations they are certified at |

The seed also creates a week of shifts around today, some assignments, an open drop request, a pending swap and a seventh-day override.

## Using the API

Swagger at `/api/docs` lists every endpoint. The exchanges below were captured from the Compose stack against the seeded data; ids are from that run and long tokens are shortened.

Sign in (local identity only; with Supabase the browser signs in with Supabase and sends that token):

```http
POST /api/auth/login
{"email": "east-manager@coastaleats.test", "password": "CoastalEats!2026"}

200 {"accessToken": "eyJhbG...4Thc"}
```

Send the token as `Authorization: Bearer <token>` on everything else. The health check is public:

```http
GET /api/health

200 {"status": "ok", "database": "up", "identityProvider": "local",
     "identityMode": "self-hosted", "uptimeSeconds": 30}
```

Ask whether someone could take a shift, without assigning them:

```http
GET /api/shifts/91bccfea-13d6-4fa1-ae8d-4d68408ce8d2/assignments/dry-run?staffId=02243b3a-d81c-42fc-bd37-18fd7ff576dc

200 {
  "allowed": false,
  "blocking": [
    {"rule": "missing_skill", "severity": "block",
     "message": "Alex Kim does not have the required skill for this shift"},
    {"rule": "unavailable", "severity": "block",
     "message": "Alex Kim is not available during the shift's time window"}
  ],
  "warnings": []
}
```

Rank the people who clear every rule, fewest hours that week first (`GET .../assignments/suggestions`), then assign one with `POST /api/shifts/:shiftId/assignments` and `{"staffId": "..."}`. Once the shift is at its headcount, further assignments are refused:

```http
POST /api/shifts/ec5168c9-19ac-4dce-990e-88e5790a2310/assignments
{"staffId": "f8868cbd-45cb-431c-9b35-a98d5eb71bbc"}

409 {"message": "Shift is fully staffed (3 of 3); raise its headcount first",
     "error": "Conflict", "statusCode": 409}
```

Ask the planner to fill a week. A manager gets their own locations unless they pass a subset in `locationIds`; the range may be up to 31 days:

```http
POST /api/planner/plan
{"from": "2026-11-08T00:00:00.000Z", "to": "2026-11-15T00:00:00.000Z"}

200 {
  "locationIds": ["07ed7a41-...", "54d585b4-..."],
  "assignments": [],
  "unfilled": [
    {"shiftId": "91bccfea-...", "shiftLabel": "Coastal Eats — Brooklyn · bartender",
     "remaining": 1,
     "blockers": [
       {"reason": "not certified at this location", "staffCount": 4},
       {"reason": "unavailable at that time", "staffCount": 4},
       {"reason": "lacks the required skill", "staffCount": 3}]}
  ],
  "metrics": {"slotsTotal": 7, "slotsFilled": 4, "coverage": 0.571,
              "hoursSpreadBefore": 4.58, "hoursSpreadAfter": 4.58},
  "explanation": {
    "summary": "No new assignments were possible. Coverage stays at 57% (4 of 7 slots). The spread of hours is unchanged at 4.6h. 3 slots across 2 shifts could not be filled; most commonly because staff were not certified at this location.",
    "source": "rules"}
}
```

Each proposed assignment carries a one-sentence `reason`. To apply one, post it as a normal assignment.

Swaps go requester, then peer, then manager. Approval re-checks the incoming person, so a swap that looked fine when requested can still be refused. The seeded John-to-Sarah swap shows this:

```http
POST /api/swap-requests/bf2bcb18-27a2-44b8-98d6-86045874fe69/accept      (as sarah)
201 {"status": "accepted_by_peer", "requesterDisplayName": "John Rivera",
     "targetStaffDisplayName": "Sarah Chen", ...}

POST /api/swap-requests/bf2bcb18-27a2-44b8-98d6-86045874fe69/approve     (as east-manager)
400 {"message": "Cannot approve swap: Sarah Chen is not certified to work at this location; Sarah Chen is not available during the shift's time window; Sarah Chen is already assigned to another shift overlapping this time",
     "error": "Bad Request", "statusCode": 400}
```

When approval succeeds, the requester's assignment passes to the peer and the request is kept with status `approved`. If the swap named the peer's own shift (`targetAssignmentId`), the requester takes that shift in return. An approved drop that nobody claimed simply removes the assignment; the request goes with it, and the notification and audit log keep the record.

## Configuration

See `.env.example`. The main variables:

- `DATABASE_URL`, `DIRECT_URL`: Postgres connection
- `PORT` (default 4000), `CORS_ORIGIN` (comma-separated)
- `AUTH_PROVIDER`: force `local` or `supabase`; otherwise Supabase is used when its URL and secret key are set
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`: enable Supabase auth
- `LOCAL_AUTH_SECRET`: signing key for the local provider's tokens. Without it a random key is generated at boot and every token dies on restart
- `SEED_PASSWORD`: password for seeded accounts

## Tests

```bash
npm test
```

47 unit tests cover the constraint engine (including timezone, overnight and consecutive-day cases), both identity providers and the plan explainer. They need no database or network.

The end-to-end suite boots the whole application against a real PostgreSQL. Each test builds its own locations, people and shifts, so it never depends on the seed:

```bash
docker run -d --name shiftsync-test-db -p 5437:5432 \
  -e POSTGRES_USER=shiftsync -e POSTGRES_PASSWORD=shiftsync -e POSTGRES_DB=shiftsync \
  -v "$PWD/docker/00-auth-schema.sql:/docker-entrypoint-initdb.d/00-auth-schema.sql:ro" \
  postgres:17-alpine
export DATABASE_URL=postgresql://shiftsync:shiftsync@localhost:5437/shiftsync
export DIRECT_URL=$DATABASE_URL
npx prisma migrate deploy
npm run test:e2e
```

Its 24 tests cover sign-in, swap and drop approval (including two-way swaps of overlapping shifts), headcount limits under concurrent requests, planner scope and fairness, and input validation.

## Design notes

- The local auth provider is meant for development. It has no refresh tokens, lockout or password reset.
- The planner is greedy: hardest shifts first, then fewest hours, then fewest premium shifts. A solver would find better rosters, but every pick here can be explained in one sentence, which matters when a manager has to defend the Saturday-night roster. It caches evaluation data per shift and person for one run; plan a month for a much larger chain and the per-pair loading would need batching.
- Applying a plan is done one assignment at a time, on purpose: the planner cannot know that someone is training a new hire on Thursday.
- Notification emails are simulated: they are logged and flagged on the notification, not sent.
- `PLANNER_LLM_API_KEY` is reserved for a model-written plan summary. No provider is wired up, so leave it unset; the rules-based summary is always used.
- The migration history references Supabase's `auth` schema. `docker/00-auth-schema.sql` creates a minimal stand-in, so the same, unedited migrations apply to plain PostgreSQL.

## License

MIT. See [LICENSE](LICENSE).
