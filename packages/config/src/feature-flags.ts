import { z } from 'zod';

/**
 * Which feature flags this process has been told to switch ON.
 *
 * `KASUWA_FEATURE_FLAGS_ON` is a comma-separated list of flag names, read from
 * the process environment and nowhere else. It exists so that a flag can be
 * turned on for a whole process by whoever starts it — today, the e2e harness
 * starting a second web server with `self_serve_signup` on (T-0007).
 *
 * Three properties are deliberate:
 *
 *   - SERVER-SIDE ONLY. Nothing a browser sends can reach this: no header, no
 *     cookie, no query string. A flag that a request can flip is not a flag, it
 *     is a public switch.
 *   - A SEPARATE ENTRY POINT from `@kasuwa/config`. That module loads the
 *     workspace `.env` and validates the API's whole environment, including a
 *     `DATABASE_URL` the web process does not have and must not be handed. This
 *     file loads nothing and parses one variable.
 *   - IT DOES NOT KNOW THE FLAG NAMES. `@kasuwa/feature-flags` owns those and
 *     rejects a name it does not declare — a typo here must fail the boot, not
 *     silently leave a flag off while someone believes it is on.
 */

const FLAG_NAME = /^[a-z][a-z0-9_]*$/;

const FlagList = z
  .string()
  .optional()
  .transform((raw) =>
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .pipe(z.array(z.string().regex(FLAG_NAME, 'not a flag name')));

export function enabledFeatureFlags(
  source: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const parsed = FlagList.safeParse(source.KASUWA_FEATURE_FLAGS_ON);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment: KASUWA_FEATURE_FLAGS_ON must be a comma-separated list of flag names (${parsed.error.issues
        .map((issue) => issue.message)
        .join(', ')})`,
    );
  }
  return [...new Set(parsed.data)];
}
