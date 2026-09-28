import type { MessageId } from '@kasuwa/i18n';

/**
 * Which strings each P01 screen needs, resolved on the SERVER.
 *
 * These lists live in a plain module, not beside the components that consume
 * them, and that is load-bearing rather than tidy: a `'use client'` file's
 * exports become client references, so a server component importing one gets a
 * proxy object instead of an array — which fails at request time with
 * "ids is not iterable" and not at compile time. It cost a full e2e run to
 * find. One module with no directive, imported by both sides.
 *
 * The lists exist at all for a bandwidth reason. `createTranslator` closes over
 * every registered catalogue; shipping all nine to a browser to render one form
 * is most of what a user on 256 kbps would be waiting for. The server resolves
 * what a screen asks for, and only that crosses the wire.
 *
 * A screen that forgets an id throws on the line that uses it — in one
 * language, for whoever chose it. That is the same trade `@kasuwa/i18n` makes
 * everywhere: a loud failure beats a blank button.
 */

/** The frame every auth screen sits in. */
export const SHELL_MESSAGE_IDS: readonly MessageId[] = [
  'app.name',
  'auth.topbar.language',
  'auth.topbar.language.current',
  'auth.topbar.lite',
  'auth.topbar.lite.on',
  'auth.topbar.lite.toggle',
  'auth.panel.headline',
  'auth.panel.body',
  'auth.panel.channel.whatsapp',
  'auth.panel.channel.voice',
  'auth.panel.channel.sms',
  'auth.panel.channel.email',
  'auth.panel.trust.encryption',
  'auth.panel.trust.compliance',
  'auth.panel.trust.residency',
];

/** `P01/1`, `1a`, `1b`, `1d` — all one route. */
export const SIGN_IN_MESSAGE_IDS: readonly MessageId[] = [
  ...SHELL_MESSAGE_IDS,
  'auth.signIn.title',
  'auth.signIn.subtitle',
  'auth.signIn.passkey',
  'auth.signIn.google',
  'auth.signIn.microsoft',
  'auth.signIn.sso',
  'auth.signIn.divider',
  'auth.signIn.workspace.label',
  'auth.signIn.workspace.help',
  'auth.signIn.email.label',
  'auth.signIn.email.placeholder',
  'auth.signIn.password.label',
  'auth.signIn.password.forgot',
  'auth.signIn.password.show',
  'auth.signIn.password.hide',
  'auth.signIn.remember',
  'auth.signIn.submit',
  'auth.signIn.submitting',
  'auth.signIn.newHere',
  'auth.signIn.createAccount',
  'auth.locked.title',
  'auth.locked.body',
  'auth.locked.retryAt',
  'auth.locked.resetEmail',
  'auth.locked.resetSms',
  'auth.locked.notYou',
  'auth.locked.tellAdmin',
  'auth.slow.loading',
  'auth.slow.title',
  'auth.slow.body',
  'auth.slow.switch',
  'auth.slow.keepWaiting',
  'auth.lite.on',
  'auth.lite.deferred',
  'auth.attemptsRemaining',
  'auth.error.validation_failed',
  'auth.error.invalid_credentials',
  'auth.error.account_locked',
  'auth.error.not_authenticated',
  'auth.error.not_implemented',
  'auth.error.network',
];

/** `P01/1c`. */
export const SSO_MESSAGE_IDS: readonly MessageId[] = [
  ...SHELL_MESSAGE_IDS,
  'auth.sso.back',
  'auth.sso.title',
  'auth.sso.subtitle',
  'auth.sso.domain.label',
  'auth.sso.domain.prefix',
  'auth.sso.domain.placeholder',
  'auth.sso.continue',
  'auth.sso.emailInstead',
  'auth.sso.providers',
  'auth.error.validation_failed',
  'auth.error.sso_domain_not_found',
  'auth.error.not_authenticated',
  'auth.error.not_implemented',
  'auth.error.network',
];

/** `P01/2`, `2a`, `2b`. */
export const MFA_MESSAGE_IDS: readonly MessageId[] = [
  ...SHELL_MESSAGE_IDS,
  'auth.mfa.title.app',
  'auth.mfa.title.sms',
  'auth.mfa.title.expired',
  'auth.mfa.body.app',
  'auth.mfa.body.sms',
  'auth.mfa.code.label',
  'auth.mfa.code.digit',
  'auth.mfa.verify',
  'auth.mfa.verifying',
  'auth.mfa.sendNew',
  'auth.mfa.trustDevice',
  'auth.mfa.alternatives',
  'auth.mfa.alt.passkey',
  'auth.mfa.alt.sms',
  'auth.mfa.alt.backup',
  'auth.mfa.alt.app',
  'auth.mfa.resend.in',
  'auth.mfa.resend.now',
  'auth.mfa.sms.slow',
  'auth.mfa.sms.voice',
  'auth.attemptsRemaining',
  'auth.error.validation_failed',
  'auth.error.mfa_code_invalid',
  'auth.error.mfa_challenge_expired',
  'auth.error.mfa_challenge_invalid',
  'auth.error.resend_too_soon',
  'auth.error.not_authenticated',
  'auth.error.not_implemented',
  'auth.error.network',
];
