'use client';

import { useId, useState, type ReactNode, type RefObject } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Button, Tabs } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { CAPS, CARD, CARD_TITLE, MiniPill } from './record-ui';

/**
 * The P05 blocks whose module does not exist yet (T-0134, D-L194): the
 * composer and its 24-hour window, the AI summary, the next best action, the
 * related lists, Identity and Addresses. Each is drawn exactly where and as
 * the export draws it, in the design's own empty or disabled state: never a
 * fake number, name, message or total. Each sits behind its own flag, read
 * on the server; this module is loaded only when one of them is on, so with
 * every flag off none of it ships.
 */

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

export type ComposerChannel = 'whatsapp' | 'sms' | 'email' | 'note';

const CHANNEL_ICON: Record<ComposerChannel, IconName> = {
  whatsapp: 'chat',
  sms: 'sms',
  email: 'mail',
  note: 'sticky_note_2',
};

const CHANNEL_LABEL: Record<ComposerChannel, MessageId> = {
  whatsapp: 'records.channel.whatsapp',
  sms: 'records.channel.sms',
  email: 'records.channel.email',
  note: 'record.activity.type.note',
};

const PLACEHOLDER: Record<ComposerChannel, MessageId> = {
  whatsapp: 'record.composer.placeholder.whatsapp',
  sms: 'record.composer.placeholder.sms',
  email: 'record.composer.placeholder.email',
  note: 'record.composer.placeholder.note',
};

const TOOL = 'flex size-10 items-center justify-center rounded-md text-text-2 is-hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-focus disabled:text-disabled-text';

/**
 * The composer card. WhatsApp, SMS and Email have no sending module yet, so
 * they are drawn disabled. WhatsApp shows the window's CLOSED state, which is
 * the true one: with no conversation served there is no open 24-hour window,
 * and outside one only approved templates may be sent (none are served yet).
 * The Note tab is live: a note is an activity, and the activity API exists.
 */
export function Composer({
  t,
  channel,
  onChannel,
  offline,
  onSaveNote,
  inputRef,
}: {
  t: Translator;
  channel: ComposerChannel;
  onChannel: (channel: ComposerChannel) => void;
  offline: boolean;
  /** Logs the note; resolves `true` when it was saved. */
  onSaveNote: (body: string) => Promise<boolean>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const panel = useId();
  const tabsId = useId();
  const live = channel === 'note';

  const save = async () => {
    if (note.trim() === '' || saving || offline) return;
    setSaving(true);
    const ok = await onSaveNote(note.trim());
    setSaving(false);
    if (ok) setNote('');
  };

  return (
    <section aria-label={t.t('record.composer.label')} className={`${CARD} overflow-hidden`}>
      <Tabs
        id={tabsId}
        aria-label={t.t('record.composer.channels')}
        items={(['whatsapp', 'sms', 'email', 'note'] as const).map((value) => ({
          value,
          label: t.t(CHANNEL_LABEL[value]),
          icon: CHANNEL_ICON[value],
          controls: panel,
        }))}
        value={channel}
        onValueChange={(value) => onChannel(value as ComposerChannel)}
        className="gap-0.5 overflow-x-auto px-1.5 pt-1"
      />
      <div id={panel} role="tabpanel" aria-labelledby={`${tabsId}-${channel}`} className="flex flex-col gap-2.5 px-3.5 py-3">
        {channel === 'whatsapp' ? (
          <>
            <div role="status" className="flex gap-2.5 rounded-10 bg-warning-soft px-3 py-2.5 text-meta text-warning-text">
              <Icon name="lock_clock" size={20} />
              <span>
                <b>{t.t('record.composer.closed.title')}</b> {t.t('record.composer.closed.body')}
              </span>
            </div>
            <div className="flex min-h-[52px] items-center gap-2.5 rounded-md border border-dashed border-border-strong px-3 py-2 text-meta text-text-2">
              <Icon name="description" size={18} />
              {t.t('record.composer.noTemplates')}
            </div>
          </>
        ) : null}
        {channel === 'note' ? (
          <textarea
            ref={inputRef}
            rows={3}
            value={note}
            disabled={offline}
            onChange={(event) => setNote(event.target.value)}
            aria-label={t.t('record.composer.message')}
            placeholder={t.t(PLACEHOLDER.note)}
            className="min-h-[76px] w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2.5 text-label font-normal text-text placeholder:text-text-muted focus-visible:field-focus disabled:bg-disabled-bg"
          />
        ) : channel === 'whatsapp' ? null : (
          <textarea
            ref={inputRef}
            rows={3}
            disabled
            aria-label={t.t('record.composer.message')}
            placeholder={t.t(PLACEHOLDER[channel])}
            className="min-h-[76px] w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2.5 text-label font-normal text-text placeholder:text-text-muted disabled:bg-disabled-bg"
          />
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" disabled aria-label={t.t('record.composer.attach')} title={t.t('record.composer.attach')} className={TOOL}>
            <Icon name="attach_file" size={20} />
          </button>
          <button type="button" disabled aria-label={t.t('record.composer.quickReply')} title={t.t('record.composer.quickReply')} className={TOOL}>
            <Icon name="bolt" size={20} />
          </button>
          <button type="button" disabled aria-label={t.t('record.composer.aiDraft')} title={t.t('record.composer.aiDraft')} className={TOOL}>
            <Icon name="auto_awesome" size={20} />
          </button>
          <span className="min-w-20 flex-1 text-caption font-normal text-text-muted">
            {t.t(live ? 'record.composer.hint.note' : 'record.composer.hint.off')}
          </span>
          {live ? (
            <Button
              variant="primary"
              icon="send"
              data-requires-connection=""
              disabled={offline || note.trim() === ''}
              loading={saving}
              onClick={() => void save()}
            >
              {t.t('record.composer.saveNote')}
            </Button>
          ) : (
            <Button variant="primary" icon="send" disabled>
              {t.t(channel === 'whatsapp' ? 'record.composer.sendTemplate' : 'record.composer.send')}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/** The AI summary card, empty: no summary is served yet. */
export function AiSummaryCard({ t }: { t: Translator }) {
  return (
    <section aria-label={t.t('record.ai.title')} className={`${CARD} gap-3 p-3.5`}>
      <div className="flex items-center gap-1.5">
        <Icon name="auto_awesome" size={18} className="text-primary-text" />
        <h2 className={`${CARD_TITLE} flex-1`}>{t.t('record.ai.title')}</h2>
      </div>
      <div className="flex flex-col gap-1">
        <b className={`${CAPS} text-text-muted`}>{t.t('record.ai.happened')}</b>
        <p className="text-meta text-text-2">{t.t('record.ai.empty')}</p>
      </div>
      <div className="flex items-center gap-1 border-t border-border pt-2">
        <span className="flex-1 text-micro font-normal text-text-muted">{t.t('record.ai.footer')}</span>
      </div>
    </section>
  );
}

/** The next-best-action card, empty: no suggestion is served yet. */
export function NextBestActionCard({ t }: { t: Translator }) {
  return (
    <section aria-label={t.t('record.nba.title')} className="flex flex-col gap-2 rounded-lg border border-primary-soft-strong bg-primary-soft p-3.5">
      <span className={`${CAPS} text-primary-text`}>{t.t('record.nba.title')}</span>
      <b className="text-label">{t.t('record.nba.empty')}</b>
      <p className="text-meta text-text-2">{t.t('record.nba.body')}</p>
      <div className="flex flex-wrap gap-1.5">
        <Button variant="primary" disabled>
          {t.t('record.nba.draft')}
        </Button>
      </div>
    </section>
  );
}

const RELATED: readonly { readonly key: string; readonly icon: IconName; readonly label: MessageId }[] = [
  { key: 'deals', icon: 'handshake', label: 'record.related.deals' },
  { key: 'tickets', icon: 'confirmation_number', label: 'record.related.tickets' },
  { key: 'quotes', icon: 'request_quote', label: 'record.related.quotes' },
  { key: 'invoices', icon: 'receipt_long', label: 'record.related.invoices' },
  { key: 'campaigns', icon: 'campaign', label: 'record.related.campaigns' },
];

function RelatedSection({ t, icon, label }: { t: Translator; icon: IconName; label: MessageId }) {
  const [open, setOpen] = useState(true);
  const body = useId();
  return (
    <div className="flex flex-col border-t border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-touch items-center gap-2 px-3.5 text-start text-body-sm font-bold focus-visible:outline-none focus-visible:ring-focus"
      >
        <Icon name={icon} size={18} className="text-text-2" />
        <span className="flex-1">{t.t(label)}</span>
        <Icon name={open ? 'expand_less' : 'expand_more'} size={18} className="text-text-2" />
      </button>
      <p id={body} hidden={!open} className="px-3.5 pb-3 text-meta text-text-muted">
        {t.t('record.related.empty')}
      </p>
    </div>
  );
}

/** Related deals, tickets, quotes, invoices and campaigns: none is served for a record yet. */
export function RelatedSections({ t }: { t: Translator }) {
  return (
    <>
      {RELATED.map((entry) => (
        <RelatedSection key={entry.key} t={t} icon={entry.icon} label={entry.label} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Identity and addresses
// ---------------------------------------------------------------------------

function IdentityRow({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-meta text-text-2">
      <Icon name={icon} size={18} />
      <span className="flex-1">{label}</span>
      {children}
    </div>
  );
}

/** Identity, not checked: no identity integration exists, and full numbers never enter Kasuwa. */
export function IdentityCard({ t }: { t: Translator }) {
  return (
    <section aria-label={t.t('record.identity.label')} className={`${CARD} gap-2.5 p-3.5`}>
      <h2 className={`${CARD_TITLE} flex items-center gap-1.5`}>
        <Icon name="verified_user" size={18} className="text-text-2" />
        {t.t('record.identity.title')}
      </h2>
      <IdentityRow icon="badge" label={t.t('record.identity.nin')}>
        <MiniPill tone="neutral" dashed>
          {t.t('record.identity.notChecked')}
        </MiniPill>
      </IdentityRow>
      <IdentityRow icon="account_balance" label={t.t('record.identity.bvn')}>
        <MiniPill tone="neutral" dashed>
          {t.t('record.identity.notChecked')}
        </MiniPill>
      </IdentityRow>
      <span className="text-caption font-normal text-text-muted">{t.t('record.identity.footer')}</span>
    </section>
  );
}

/**
 * Addresses: the State and LGA the record holds, in the export's address
 * block. Street and landmark are not served, so they are not drawn.
 */
export function AddressesCard({
  t,
  state,
  lga,
  locked,
  titleId = 'record.addresses.location',
}: {
  t: Translator;
  state: string | null;
  lga: string | null;
  locked: boolean;
  titleId?: MessageId;
}) {
  const known = !locked && (state !== null || lga !== null);
  return (
    <section aria-label={t.t('record.addresses.title')} className={`${CARD} gap-2.5 p-3.5`}>
      <div className="flex items-center">
        <h2 className={`${CARD_TITLE} flex-1`}>{t.t('record.addresses.title')}</h2>
        <button
          type="button"
          disabled
          aria-label={t.t('record.addresses.add')}
          title={t.t('record.addresses.add')}
          className="flex size-10 items-center justify-center rounded-md text-primary-text disabled:text-disabled-text"
        >
          <Icon name="add" size={20} />
        </button>
      </div>
      {known ? (
        <div className="flex flex-col gap-1.5 rounded-10 border border-border px-3 py-2.5">
          <span className="flex items-center gap-1.5">
            <Icon name="location_on" size={18} className="text-text-2" />
            <b className="flex-1 text-meta font-bold">{t.t(titleId)}</b>
          </span>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-caption font-normal">
            {state === null ? null : (
              <>
                <dt className="text-text-muted">{t.t('record.field.state')}</dt>
                <dd data-record-text="">{state}</dd>
              </>
            )}
            {lga === null ? null : (
              <>
                <dt className="text-text-muted">{t.t('record.field.lga')}</dt>
                <dd data-record-text="">{lga}</dd>
              </>
            )}
          </dl>
        </div>
      ) : (
        <p className="text-meta text-text-muted">{t.t('record.addresses.empty')}</p>
      )}
    </section>
  );
}
