-- Minimal stand-in for the `auth` schema that Supabase provisions.
--
-- Two migrations in this project's history reference `auth.users`: one adds a
-- foreign key from `public.users`, and one attaches a trigger that creates a
-- profile row on signup. Against a Supabase database that schema already
-- exists; against a plain Postgres it does not, so the migration history could
-- not be applied at all and the project could only ever run on Supabase.
--
-- Creating a compatible table here lets the *same, unedited* migration history
-- apply locally. That matters more than it might look: local development then
-- exercises the real foreign key and the real trigger, rather than a divergent
-- schema that happens to work.
--
-- Only the columns this project actually reads are included. Everything is
-- IF NOT EXISTS, so running against a real Supabase database is a no-op.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY,
  email              text UNIQUE,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Supabase exposes auth.uid() to row-level-security policies, reading the
-- caller's id out of the request JWT. One migration creates a policy that uses
-- it. Locally the API connects as the table owner, so RLS is not enforced and
-- this only needs to exist for the policy to be creatable — but it reads the
-- same GUC Supabase uses, so a policy could still be exercised deliberately.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Supabase ships a logical-replication publication named `supabase_realtime`,
-- and a migration adds the notifications table to it so the frontend can
-- subscribe to row changes. Creating an empty publication of the same name
-- lets that migration apply against plain Postgres. Nothing consumes it
-- locally — the frontend falls back to polling when Realtime is unavailable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;
