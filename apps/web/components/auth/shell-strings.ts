import type { Translator } from '@kasuwa/i18n';
import type { ShellStrings } from './auth-shell';

/**
 * The auth frame's strings, read out of a bundle the server already resolved.
 * The ids themselves are in `message-ids.ts`, which has no `'use client'`
 * directive and can therefore be imported from a server component.
 */
export function shellStrings(t: Translator): ShellStrings {
  return {
    brand: t.t('app.name'),
    languageLabel: t.t('auth.topbar.language'),
    languageCurrent: t.t('auth.topbar.language.current', { language: t.t('auth.topbar.language') }),
    liteLabel: t.t('auth.topbar.lite'),
    liteOnLabel: t.t('auth.topbar.lite.on'),
    liteToggleName: t.t('auth.topbar.lite.toggle'),
    panelHeadline: t.t('auth.panel.headline'),
    panelBody: t.t('auth.panel.body'),
    channelWhatsapp: t.t('auth.panel.channel.whatsapp'),
    channelVoice: t.t('auth.panel.channel.voice'),
    channelSms: t.t('auth.panel.channel.sms'),
    channelEmail: t.t('auth.panel.channel.email'),
    trustEncryption: t.t('auth.panel.trust.encryption'),
    trustCompliance: t.t('auth.panel.trust.compliance'),
    trustResidency: t.t('auth.panel.trust.residency'),
  };
}
