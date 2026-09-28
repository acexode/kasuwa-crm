import { bundleMessages, localeLabel, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { SignInScreen } from '../components/auth/sign-in-screen';
import { SIGN_IN_MESSAGE_IDS } from '../components/auth/message-ids';
import { activeLocale } from '../lib/locale';

/**
 * `P01/1` — sign in. The application's front door.
 *
 * A SERVER component that resolves strings and hands a plain bundle to one
 * client island. That is a bandwidth decision, not a style: `createTranslator`
 * closes over every registered catalogue, and shipping nine of them to render
 * one form is most of what a user on 256 kbps would be waiting for.
 *
 * THE LANGUAGE MENU COMES FROM `SUPPORTED_LOCALES` AND FROM NOWHERE ELSE.
 * That constant is derived from catalogue completeness plus a named reviewer
 * (D-P1), so it offers exactly the languages that are finished. Today it is two
 * — `en` and `en-NG`. Six more are structurally complete and deliberately held
 * back until a human who reads each one signs it off, and the menu shows what
 * the gate offers rather than what the design hoped for. Shipping a menu entry
 * that falls back to English is worse than offering fewer languages.
 */
export default async function SignInPage() {

  const { locale } = await activeLocale();

  return (
    <SignInScreen
      locale={locale}
      messages={bundleMessages(locale, SIGN_IN_MESSAGE_IDS)}
      locales={SUPPORTED_LOCALES.map((code) => ({ code, label: localeLabel(code) }))}
    />
  );
}
