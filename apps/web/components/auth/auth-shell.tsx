'use client';

import type { ReactNode } from 'react';
import { Icon } from '../icon';
import { LanguageMenu, type LanguageOption } from './language-menu';
import { LiteModeToggle, useLiteMode } from './lite-mode';

/**
 * The frame every P01 screen sits in: brand, language menu, lite-mode switch,
 * and on a wide screen the trust panel from the design.
 *
 * The panel is TEXT ONLY and disappears in lite mode. That is the design's
 * decision and it is the right one for the network these screens run on: a hero
 * image at 256 kbps is several seconds of a blank form. "Trust without logos"
 * is the cover note on the board — plain statements with icons, which cost
 * nothing to send.
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
}

export function AuthShell({
  strings,
  locales,
  currentLocale,
  showPanel = true,
  children,
}: {
  strings: ShellStrings;
  locales: readonly LanguageOption[];
  currentLocale: string;
  showPanel?: boolean;
  children: ReactNode;
}) {
  const { lite } = useLiteMode();
  const withPanel = showPanel && !lite;

  return (
    <div className="flex min-h-screen bg-bg text-text">
      {withPanel ? (
        <aside className="hidden flex-shrink-0 flex-col gap-6 bg-primary-soft p-12 lg:flex lg:w-1/3">
          <p className="flex items-center gap-2 text-h4">
            <BrandMark />
            <span className="font-bold">{strings.brand}</span>
          </p>
          <div className="flex flex-1 flex-col justify-center gap-4">
            <h2 className="text-h2 text-text">{strings.panelHeadline}</h2>
            <p className="text-body-lg text-text-2">{strings.panelBody}</p>
            <ul className="flex list-none flex-wrap gap-2 p-0">
              <Channel icon="chat" label={strings.channelWhatsapp} tone="text-success-text" />
              <Channel icon="call" label={strings.channelVoice} tone="text-primary-text" />
              <Channel icon="sms" label={strings.channelSms} tone="text-text-2" />
              <Channel icon="mail" label={strings.channelEmail} tone="text-info-text" />
            </ul>
          </div>
          <ul className="flex list-none flex-col gap-3 border-t border-primary-soft-strong p-0 pt-6">
            <Trust label={strings.trustEncryption} icon="lock" />
            <Trust label={strings.trustCompliance} icon="verified_user" />
            <Trust label={strings.trustResidency} icon="public" />
          </ul>
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-touch flex-shrink-0 items-center gap-2 px-5 py-2">
          {withPanel ? null : (
            <p className="flex items-center gap-2 text-body-lg font-bold">
              <BrandMark />
              <span>{strings.brand}</span>
            </p>
          )}
          <span className="flex-1" />
          <LiteModeToggle
            label={strings.liteLabel}
            onLabel={strings.liteOnLabel}
            accessibleName={strings.liteToggleName}
            compact={false}
          />
          <LanguageMenu
            options={locales}
            current={currentLocale}
            label={strings.languageLabel}
            currentLabel={strings.languageCurrent}
            compact={false}
          />
        </header>

        <div className="flex flex-1 flex-col items-center justify-center px-5 pb-10 pt-8">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The "K" mark. A styled letter rather than an SVG or an image: it is one glyph
 * in a font the page already downloaded, so it costs no request at all.
 */
function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-h5 font-extrabold text-accent"
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
    <li className="inline-flex min-h-touch items-center gap-2 rounded-full bg-surface px-3 text-body-sm font-semibold">
      <Icon name={icon} size="sm" className={tone} />
      {label}
    </li>
  );
}

function Trust({ icon, label }: { icon: 'lock' | 'verified_user' | 'public'; label: string }) {
  return (
    <li className="flex items-center gap-3 text-body-sm text-text-2">
      <Icon name={icon} className="text-success-text" />
      {label}
    </li>
  );
}
