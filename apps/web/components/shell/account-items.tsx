'use client';

import { useId, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { BetaBadge, chooseLanguage, type LanguageOption } from '../auth/language-choice';
import { useLiteMode } from '../auth/lite-mode';
import { signOut } from '../../lib/sign-out';
import { SIGN_IN_PATH } from '../../lib/api-fetch';
import { SHELL_FOCUS } from './shell-parts';

/**
 * The account menu's items (T-0130), in a module of their own (T-0145): the
 * list is drawn only after a press on the avatar or the phone's More, so it
 * loads then, through `loadAccountItems` in `account-menu`, and costs a screen
 * nothing until someone opens it.
 */

const ROW = `flex h-control-md w-full items-center gap-2.5 rounded-6 px-3 text-start text-body-sm text-text is-hover:bg-surface-sunken ${SHELL_FOCUS}`;

export function AccountItems({
  t,
  locale,
  locales,
  withLite,
  name,
}: {
  t: Translator;
  locale: string;
  locales: readonly LanguageOption[];
  /** The lite-mode switch, where the bar itself has none (the admin bar, the phone sheet). */
  withLite: boolean;
  name: string | null;
}) {
  const [pending, setPending] = useState(false);
  const { lite, setLite } = useLiteMode();
  const groupId = useId();
  const helpLink = locales.find((option) => option.beta !== undefined)?.beta;

  return (
    <>
      {name === null ? null : (
        <p className="truncate px-3 pb-1 pt-2 text-body-sm font-semibold text-text">{name}</p>
      )}
      {withLite ? (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={lite}
          data-testid="lite-mode-toggle"
          onClick={() => setLite(!lite)}
          className={ROW}
        >
          <Icon name="network_check" size={20} className="text-text-2" />
          <span className="flex-1">{t.t('auth.topbar.lite.toggle')}</span>
          {lite ? <Icon name="check" size={20} className="text-primary-text" /> : null}
        </button>
      ) : null}
      <p id={groupId} className="px-3 pb-1 pt-2 text-overline text-text-muted">
        {t.t('auth.topbar.language')}
      </p>
      <div role="group" aria-labelledby={groupId} className="flex flex-col">
        {locales.map((option) => {
          const selected = option.code === locale;
          return (
            <button
              key={option.code}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              lang={option.code}
              data-testid="language-option"
              onClick={() => {
                if (!selected) chooseLanguage(option.code);
              }}
              className={`${ROW} ${selected ? 'bg-primary-soft font-semibold' : ''}`}
            >
              <span className="flex-1">{option.label}</span>
              {option.beta === undefined ? null : <BetaBadge text={option.beta.badge} lang={locale} />}
              {selected ? <Icon name="check" size={20} className="text-primary-text" /> : null}
            </button>
          );
        })}
      </div>
      {helpLink === undefined ? null : (
        <a
          href={helpLink.href}
          role="menuitem"
          data-testid="language-help"
          lang={locale}
          className={`${ROW} font-semibold text-primary-text underline underline-offset-2`}
        >
          <Icon name="translate" size={20} />
          {helpLink.help}
        </a>
      )}
      <span role="separator" className="mx-1 my-1 block border-t border-border" />
      <button
        type="button"
        role="menuitem"
        data-testid="sign-out"
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        onClick={() => {
          if (pending) return;
          setPending(true);
          void signOut().then(() => {
            window.location.assign(SIGN_IN_PATH);
          });
        }}
        className={ROW}
      >
        <Icon name="logout" size={20} className="text-text-2" />
        {t.t('auth.signOut')}
      </button>
    </>
  );
}
