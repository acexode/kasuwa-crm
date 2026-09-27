/**
 * The numbers authentication runs on.
 *
 * Injected rather than read from the environment inside the service, for the
 * same reason `AppModule.forRoot` takes a database URL: a test must be able to
 * stand up an app with different numbers without mutating process.env, and
 * `main.ts` stays the one place that reads configuration.
 *
 * Defaults are the P01 design's: lock after five failures for fifteen minutes,
 * a second factor valid for ten minutes with five attempts, a sixty-second
 * resend window. The session lifetime is provisional — see the note in
 * @kasuwa/config.
 */
export interface AuthPolicy {
  /** Failed first-factor attempts before the identifier is locked. 0 disables lockout. */
  lockoutMaxAttempts: number;
  /** Failures older than this stop counting towards a lockout. */
  lockoutWindowMinutes: number;
  /** How long a lockout lasts. */
  lockoutMinutes: number;
  /** How long a second-factor challenge stays open. */
  challengeMinutes: number;
  /** Wrong codes allowed against one challenge before it is burned. */
  challengeMaxAttempts: number;
  /**
   * Wrong codes allowed against one USER before their second factor is locked,
   * across every challenge.
   *
   * Distinct from `challengeMaxAttempts` and the more important of the two.
   * Burning a challenge alone bounds nothing: somebody holding a stolen
   * password simply opens another. This is the number that decides how many
   * guesses a stolen password buys in total.
   */
  mfaMaxAttempts: number;
  /**
   * How many second-factor challenges one user may have open at once.
   *
   * The other half of the same control. Without a cap, an attacker opens a
   * thousand challenges and gets `challengeMaxAttempts` guesses against each.
   */
  maxOpenChallenges: number;
  /** Absolute session lifetime. No refresh in T-0001. */
  sessionHours: number;
  /** How long before a one-time code may be re-sent. */
  resendSeconds: number;
  /**
   * Sign-in requests one client address may make per minute.
   *
   * This exists for resource exhaustion, not for credential guessing — the
   * lockout above handles that. Every sign-in runs argon2id at 19 MiB,
   * including for addresses and workspaces that do not exist, because
   * equalising the timing means doing the work either way. Unbounded, a few
   * hundred concurrent requests cost gigabytes and take the cell down for every
   * tenant on it, and varying the email means the identifier lockout never
   * trips.
   */
  signInPerMinutePerClient: number;
  /**
   * The IANA zone a retry time is rendered in, for the whole cell.
   *
   * ONE value per deployment, not per tenant, and that is deliberate. Deriving
   * it from the tenant made the lockout response for a workspace that does not
   * exist differ from one that does, and disclosed the hosting region of any
   * workspace an attacker could name. The browser knows the user's own zone and
   * should render `retryAt` in it; this is the fallback label.
   */
  cellTimeZone: string;
}

export const AUTH_POLICY = Symbol('AUTH_POLICY');

export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  lockoutMaxAttempts: 5,
  lockoutWindowMinutes: 15,
  lockoutMinutes: 15,
  challengeMinutes: 10,
  challengeMaxAttempts: 5,
  mfaMaxAttempts: 10,
  maxOpenChallenges: 3,
  sessionHours: 12,
  resendSeconds: 60,
  signInPerMinutePerClient: 60,
  cellTimeZone: 'Africa/Lagos',
};
