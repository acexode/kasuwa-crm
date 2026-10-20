'use client';

import type { ReactNode } from 'react';
import { Icon } from '../icon';
import { LanguageMenu, type LanguageOption } from './language-menu';
import { LiteModeToggle, useLiteMode } from './lite-mode';

/**
 * The frame every P01 screen sits in (T-0131, to `Kasuwa Auth and
 * Onboarding`): brand, language menu, lite-mode switch, and on a wide screen
 * the 520px trust panel from the design, on EVERY state, the failure states
 * included.
 *
 * The panel is TEXT ONLY and disappears in lite mode. That is the design's
 * decision and it is the right one for the network these screens run on: a hero
 * image at 256 kbps is several seconds of a blank form. "Trust without logos"
 * is the cover note on the board — plain statements with icons, which cost
 * nothing to send.
 *
 * Where the panel is not drawn (a phone, or lite mode), the same three trust
 * statements move to a compact footer, so a phone user still learns where the
 * data lives before typing a password.
 */

export interface ShellStrings {
  readonly brand: string;
  readonly languageLabel: string;
  readonly languageCurrent: string;
  readonly liteLabel: string;
  readonly liteOnLabel: string;
  readonly liteToggleName: string;
  readonly panelHeadline: string;
  readonly panelBody: string;
  readonly channelWhatsapp: string;
  readonly channelVoice: string;
  readonly channelSms: string;
  readonly channelEmail: string;
  readonly trustEncryption: string;
  readonly trustCompliance: string;
  readonly trustResidency: string;
  readonly footerEncryption: string;
  readonly footerCompliance: string;
  readonly footerResidency: string;
}

export type TopBarStrings = Pick<
  ShellStrings,
  'brand' | 'languageLabel' | 'languageCurrent' | 'liteLabel' | 'liteOnLabel' | 'liteToggleName'
>;

export function AuthShell({
  strings,
  locales,
  currentLocale,
  showPanel = true,
  trustFooter = true,
  children,
}: {
  strings: ShellStrings;
  locales: readonly LanguageOption[];
  currentLocale: string;
  showPanel?: boolean;
  /** The phone trust strip. The success screen (P01/6) has none on the board. */
  trustFooter?: boolean;
  children: ReactNode;
}) {
  const { lite } = useLiteMode();
  const withPanel = showPanel && !lite;

  return (
    <div className="flex min-h-screen bg-bg text-text">
      {withPanel ? (
        <aside className="hidden w-layout-auth-panel flex-shrink-0 flex-col gap-7 self-start overflow-y-auto bg-primary-soft px-14 py-12 lg:sticky lg:top-0 lg:flex lg:h-screen">
          <p className="flex items-center gap-2.5">
            <BrandMark size="lg" />
            <span className="text-h4 font-bold">{strings.brand}</span>
          </p>
          <span aria-hidden="true" className="flex-1" />
          <h2 className="text-headline text-pretty text-text">{strings.panelHeadline}</h2>
          <p className="text-body-lg text-pretty text-text-2">{strings.panelBody}</p>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            <Channel icon="chat" label={strings.channelWhatsapp} tone="text-success-text" />
            <Channel icon="call" label={strings.channelVoice} tone="text-primary-text" />
            <Channel icon="sms" label={strings.channelSms} tone="text-text-2" />
            <Channel icon="mail" label={strings.channelEmail} tone="text-info-text" />
          </ul>
          <span aria-hidden="true" className="flex-1" />
          <ul className="m-0 flex list-none flex-col gap-3 border-t border-primary-soft-strong p-0 pt-6">
            <Trust label={strings.trustEncryption} icon="lock" />
            <Trust label={strings.trustCompliance} icon="verified_user" />
            <Trust label={strings.trustResidency} icon="public" />
          </ul>
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <AuthTopBar
          strings={strings}
          locales={locales}
          currentLocale={currentLocale}
          logo={withPanel ? 'below-lg' : 'always'}
        />

        <div className="flex flex-1 flex-col items-center px-5 pb-10 pt-8">{children}</div>

        {/* The panel's trust lines, for every screen that does not draw the panel. */}
        {trustFooter ? (
          <ul
            className={`m-0 list-none flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-border px-4 py-3 text-caption font-normal text-text-2 ${
              withPanel ? 'flex lg:hidden' : 'flex'
            }`}
          >
            <FooterTrust icon="lock" label={strings.footerEncryption} />
            <FooterTrust icon="verified_user" label={strings.footerCompliance} />
            <FooterTrust icon="public" label={strings.footerResidency} />
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The 64px top bar: the logo where the panel is not showing it, then lite mode
 * and the language menu, icon-and-code on a phone so neither label wraps at
 * 360. Shared with the setup wizard, which adds a bottom border.
 */
export function AuthTopBar({
  strings,
  locales,
  currentLocale,
  logo,
  bordered = false,
  extra,
}: {
  strings: TopBarStrings;
  locales: readonly LanguageOption[];
  currentLocale: string;
  /** `below-lg`: the brand panel shows the logo on a wide screen. */
  logo: 'always' | 'below-lg';
  bordered?: boolean;
  /** Before the lite switch: the wizard's phone "Skip". */
  extra?: ReactNode;
}) {
  return (
    <header
      className={`flex h-layout-auth-header flex-shrink-0 items-center gap-1.5 pe-3 ps-5 ${
        bordered ? 'border-b border-border' : ''
      }`}
    >
      <p className={`items-center gap-2 ${logo === 'below-lg' ? 'flex lg:hidden' : 'flex'}`}>
        <BrandMark size="md" />
        <span className="text-body-md font-bold">{strings.brand}</span>
      </p>
      <span className="flex-1" />
      {extra}
      <LiteModeToggle
        label={strings.liteLabel}
        onLabel={strings.liteOnLabel}
        accessibleName={strings.liteToggleName}
        compact="phone"
      />
      <LanguageMenu
        options={locales}
        current={currentLocale}
        label={strings.languageLabel}
        currentLabel={strings.languageCurrent}
        compact="phone"
      />
    </header>
  );
}

/**
 * The "K" mark. A styled letter rather than an SVG or an image: it is one glyph
 * in a font the page already downloaded, so it costs no request at all. 40px
 * radius 10 in the panel, 32px radius 8 in the top bar.
 */
export function BrandMark({ size }: { size: 'lg' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={`flex flex-shrink-0 items-center justify-center bg-primary font-extrabold leading-none text-accent ${
        size === 'lg' ? 'size-10 rounded-10 text-icon-22' : 'size-8 rounded-md text-h5'
      }`}
    >
      K
    </span>
  );
}

function Channel({
  icon,
  label,
  tone,
}: {
  icon: 'chat' | 'call' | 'sms' | 'mail';
  label: string;
  tone: string;
}) {
  return (
    <li className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-surface px-3 text-body-sm font-semibold">
      <Icon name={icon} size={18} className={tone} />
      {label}
    </li>
  );
}

function Trust({ icon, label }: { icon: 'lock' | 'verified_user' | 'public'; label: string }) {
  return (
    <li className="flex items-center gap-2.5 text-body-sm text-text-2">
      <Icon name={icon} size={20} className="text-success-text" />
      {label}
    </li>
  );
}

function FooterTrust({
  icon,
  label,
}: {
  icon: 'lock' | 'verified_user' | 'public';
  label: string;
}) {
  return (
    <li className="inline-flex items-center gap-1">
      <Icon name={icon} size={15} className="text-success-text" />
      {label}
    </li>
  );
}
