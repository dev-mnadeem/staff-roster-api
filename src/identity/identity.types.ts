/**
 * Everything the application needs to know about who is making a request.
 *
 * Deliberately not Supabase's `User` shape: the domain should not care which
 * identity vendor issued the token, and typing against a vendor's type is what
 * made the previous arrangement impossible to run or test without that vendor.
 */
export interface AuthPrincipal {
  id: string;
  email?: string;
  role?: string;
  appMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
}

/** The account record behind a principal, for display on the profile screen. */
export interface AuthAccount {
  id: string;
  email: string;
  emailConfirmed: boolean;
  lastSignInAt?: string;
}

export interface IdentityProvider {
  /** Stable id used in logs and health output, e.g. "supabase" or "local". */
  readonly name: string;
  /** True when identity is managed by an external, billable service. */
  readonly isExternal: boolean;

  /** Verifies a bearer token, or throws. */
  verifyToken(token: string): Promise<AuthPrincipal>;

  /** Looks up the account record for a verified principal. */
  getAccount(userId: string): Promise<AuthAccount | null>;

  /**
   * Bulk email lookup, keyed by user id.
   *
   * Three services each had their own copy of this against the Supabase admin
   * API. Consolidating it here removed that duplication and, more importantly,
   * is what let those services work under either provider.
   *
   * Pass the ids of interest so a provider can narrow the query; omit them to
   * fetch everyone.
   */
  getEmailMap(userIds?: string[]): Promise<Map<string, string>>;

  /**
   * Exchanges credentials for a token.
   *
   * Only the local provider implements this — with a hosted identity service
   * the browser talks to the vendor directly and the API never sees a password.
   * Returns null when the provider does not support direct sign-in, which the
   * controller turns into a clear 501 rather than a confusing 401.
   */
  signIn?(
    email: string,
    password: string,
  ): Promise<{ accessToken: string } | null>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
