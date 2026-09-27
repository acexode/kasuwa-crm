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
  /** Absolute session lifetime. No refresh in T-0001. */
  sessionHours: number;
  /** How long before a one-time code may be re-sent. */
  resendSeconds: number;
}

export const AUTH_POLICY = Symbol('AUTH_POLICY');

export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  lockoutMaxAttempts: 5,
  lockoutWindowMinutes: 15,
  lockoutMinutes: 15,
  challengeMinutes: 10,
  challengeMaxAttempts: 5,
  sessionHours: 12,
  resendSeconds: 60,
};

/**
 * Which IANA zone a retry time should be rendered in.
 *
 * `P01/1b` requires the zone alongside the time: "try again in 15 minutes" is
 * useless to somebody whose phone clock is on a different zone from the
 * workspace, and BPO rosters routinely span WAT, EAT and SAST.
 *
 * Derived from the tenant's region cell, which is the only location fact the
 * schema currently holds. This is an approximation — a Nigerian tenant hosted
 * in `za-1` will be told a Johannesburg time — and it stops being one when the
 * tenant gains a real timezone column. Recorded as an open question in
 * team/reports/T-0001.md rather than papered over with a guess at the user's
 * own zone, which the server does not know.
 */
const REGION_CELL_ZONES: Readonly<Record<string, string>> = {
  'za-1': 'Africa/Johannesburg',
  'ng-1': 'Africa/Lagos',
  'ke-1': 'Africa/Nairobi',
};

export function timeZoneForRegionCell(regionCell: string | null | undefined): string {
  return (regionCell === null || regionCell === undefined ? undefined : REGION_CELL_ZONES[regionCell]) ?? 'UTC';
}
