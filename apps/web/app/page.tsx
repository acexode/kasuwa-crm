import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { SignInScreen } from '../components/auth/sign-in-screen';
import { SIGN_IN_MESSAGE_IDS } from '../components/auth/message-ids';
import { selfServeSignupEnabled } from '../lib/feature-flags';
import { activeLocale, languageOptions } from '../lib/locale';
import { carriesSessionCookie, landingPath } from '../lib/server/landing';

/**
 * `P01/1` — sign in. The application's front door.
 *
 * A SERVER component that resolves strings and hands a plain bundle to one
 * client island. That is a bandwidth decision, not a style: `createTranslator`
 * closes over every registered catalogue, and shipping nine of them to render
 * one form is most of what a user on 256 kbps would be waiting for.
 *
 * THE LANGUAGE MENU COMES FROM `languageOptions()` AND FROM NOWHERE ELSE.
 * It lists `SUPPORTED_LOCALES` — complete and signed off by a named reviewer —
 * plus `BETA_LOCALES`, complete but not yet signed off, each with a Beta badge
 * and a "help improve this translation" link (D-P1, answered 2026-10-03). Both
 * lists are derived from the catalogues, so every entry is finished: shipping
 * a menu entry that falls back to English is worse than offering fewer
 * languages, and a Beta entry is unreviewed, never incomplete.
 *
 * A BROWSER THAT ALREADY HOLDS A SESSION COOKIE is sent on to the app
 * (T-0125), for example after following a link to the front door. The second
 * factor does not come through here: it goes straight to the same landing. A dead cookie bounces once: the landing screen's first
 * read is a 401, the BFF clears the cookie, and the browser returns here with
 * none. See `lib/server/landing.ts`.
 */
export default async function SignInPage() {
  if (carriesSessionCookie((await headers()).get('cookie'))) {
    redirect(await landingPath());
  }

  const { locale } = await activeLocale();
  // D-P2: a link to a route that 404s is worse than no link. Server-side only.
  const signUpOpen = await selfServeSignupEnabled();

  return (
    <SignInScreen
      locale={locale}
      messages={bundleMessages(locale, SIGN_IN_MESSAGE_IDS)}
      locales={languageOptions(locale)}
      signUpOpen={signUpOpen}
    />
  );
}
