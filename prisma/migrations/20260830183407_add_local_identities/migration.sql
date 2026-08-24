-- Credentials for the self-hosted identity provider.
--
-- Only populated when the application runs without Supabase. `id` intentionally
-- matches public.users.id so a profile is reachable from either provider; no
-- foreign key is declared because public.users.id already references
-- auth.users(id), and the local seed writes that row first.
CREATE TABLE "local_identities" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "email_confirmed" BOOLEAN NOT NULL DEFAULT true,
    "last_sign_in_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "local_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "local_identities_email_key" ON "local_identities"("email");
