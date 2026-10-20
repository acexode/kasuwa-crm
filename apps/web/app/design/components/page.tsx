import type { ReactNode } from 'react';
import { DESIGN_VERSION } from '@kasuwa/ui';
import {
  Avatar,
  Button,
  Checkbox,
  Chip,
  CountBadge,
  IconButton,
  Kbd,
  Pill,
  Radio,
  SegmentedControl,
  Select,
  Switch,
  Tabs,
  Tag,
  TextField,
  type ButtonVariant,
} from '@kasuwa/ui/components';
import { createTranslator } from '@kasuwa/i18n';
import { activeLocale } from '../../../lib/locale';

/**
 * The component gallery (T-0128, D-L200), beside /design/tokens.
 *
 * Every control in `@kasuwa/ui/components`, in every state the v1.1
 * Components page draws, laid out like that page so a reviewer can put the
 * two side by side. Hover, focus and press are shown at rest with
 * `data-preview`, which the same classes that style the live state also
 * match: what is drawn here is what a screen gets.
 *
 * It follows the device's light or dark setting, so both themes are one
 * `prefers-color-scheme` away. `?locale=ar` renders it right to left.
 *
 * THE GALLERY CONTRACT. `data-gallery="<id>"` sits on the element that IS the
 * control (the button, the input, the chip), never on a wrapper. The e2e
 * journey tests/e2e/design-components.spec.ts measures the computed style of
 * each one against the v1.1 values. Change an id only with that file.
 *
 * Sample people, values and team names are fixture data, as in a seed: they
 * are not copy, and every word of copy goes through @kasuwa/i18n.
 */

const SAMPLE = {
  placeholderName: 'Ọláńrewájú Adébáyọ̀',
  hoverValue: 'Chukwuemeka Ọnwụ',
  focusValue: 'Ɗanladi Ƙaura',
  emailValue: 'ama.serwaa@',
  emailExample: 'ama@asante.com.gh',
  accountId: 'ACC-00481-LOS',
  queues: ['Lagos Sales', 'Accra Collections', 'Nairobi Support', 'Joburg Retention'],
  // v1.1 draws KM, EO, WK and TN on primary, accent, info and success. These
  // names hash to exactly those fills (avatarTone), so the row reads the same.
  people: ['Kwame Mensah', 'Efua Owusu', 'Wanjiru Kiprop', 'Thabo Nkosi'],
  offline: 'Aïssatou Diallo',
  rows: ['Adaeze Eze', 'Tunde Adébáyọ̀', 'Amina Danjuma', 'Halima Chukwu'],
} as const;

type Translate = ReturnType<typeof createTranslator>['t'];

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-overline text-primary-text">{label}</h2>
      {children}
    </section>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:p-6">
      {title === undefined ? null : <h3 className="text-h5 font-bold text-text">{title}</h3>}
      {children}
    </div>
  );
}

/** A grid that scrolls sideways inside itself on a phone, never the page. */
function Scroller({ children }: { children: ReactNode }) {
  return <div className="-m-1 overflow-x-auto p-1">{children}</div>;
}

function ColumnHead({ children }: { children: ReactNode }) {
  return <span className="text-overline text-text-muted">{children}</span>;
}

function RowHead({ children }: { children: ReactNode }) {
  return <span className="text-meta font-semibold text-text-2">{children}</span>;
}

const BUTTON_ROWS: readonly {
  variant: ButtonVariant;
  label: 'primary' | 'secondary' | 'ghost' | 'danger';
  text: 'save' | 'export' | 'cancel' | 'delete';
  loading: 'saving' | 'export' | 'undo' | 'deleting';
}[] = [
  { variant: 'primary', label: 'primary', text: 'save', loading: 'saving' },
  { variant: 'secondary', label: 'secondary', text: 'export', loading: 'export' },
  { variant: 'ghost', label: 'ghost', text: 'cancel', loading: 'undo' },
  { variant: 'danger', label: 'danger', text: 'delete', loading: 'deleting' },
];

function Buttons({ t }: { t: Translate }) {
  const states = ['default', 'hover', 'focus', 'active', 'disabled', 'loading'] as const;
  return (
    <Card title={t('design.components.heading.buttons')}>
      <Scroller>
        <div className="grid w-full min-w-max grid-cols-[auto_repeat(6,minmax(0,1fr))] items-center gap-x-2 gap-y-2.5">
          <span />
          {states.map((state) => (
            <ColumnHead key={state}>{t(`design.components.state.${state}`)}</ColumnHead>
          ))}
          {BUTTON_ROWS.map((row) => {
            const text = t(`design.components.sample.${row.text}`);
            return [
              <RowHead key={`${row.variant}-label`}>
                {t(`design.components.variant.${row.label}`)}
              </RowHead>,
              <Button
                key={`${row.variant}-default`}
                variant={row.variant}
                data-gallery={`button-${row.variant}`}
              >
                {text}
              </Button>,
              <Button key={`${row.variant}-hover`} variant={row.variant} data-preview="hover">
                {text}
              </Button>,
              <Button key={`${row.variant}-focus`} variant={row.variant} data-preview="focus">
                {text}
              </Button>,
              <Button key={`${row.variant}-active`} variant={row.variant} data-preview="active">
                {text}
              </Button>,
              <Button
                key={`${row.variant}-disabled`}
                variant={row.variant}
                disabled
                data-gallery={row.variant === 'primary' ? 'button-primary-disabled' : undefined}
              >
                {text}
              </Button>,
              <Button
                key={`${row.variant}-loading`}
                variant={row.variant}
                loading
                loadingLabel={t(`design.components.sample.${row.loading}`)}
              >
                {text}
              </Button>,
            ];
          })}
          <RowHead>{t('design.components.variant.icon')}</RowHead>
          <IconButton
            icon="call"
            label={t('design.components.sample.call')}
            data-gallery="icon-button"
          />
          <IconButton icon="call" label={t('design.components.sample.call')} data-preview="hover" />
          <IconButton icon="call" label={t('design.components.sample.call')} data-preview="focus" />
          <IconButton icon="call" label={t('design.components.sample.call')} pressed />
          <IconButton icon="call" label={t('design.components.sample.call')} disabled />
          <IconButton icon="call" label={t('design.components.sample.connecting')} loading />
        </div>
      </Scroller>
    </Card>
  );
}

function CompactButtons({ t }: { t: Translate }) {
  return (
    <Card title={t('design.components.heading.compact')}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="compact" icon="add" data-gallery="button-primary-compact">
          {t('design.components.sample.newLead')}
        </Button>
        <Button size="compact" icon="view_column">
          {t('design.components.sample.columns')}
        </Button>
        <Button variant="ghost" size="compact">
          {t('design.components.sample.cancel')}
        </Button>
      </div>
    </Card>
  );
}

function Inputs({ t }: { t: Translate }) {
  const state = (
    label: string,
    name: 'default' | 'hover' | 'focus' | 'error' | 'disabled' | 'loading',
  ) => (
    <>
      {label}
      {' · '}
      {t(`design.components.state.${name}`)}
    </>
  );
  const fullName = t('design.components.field.fullName');
  const email = t('design.components.field.email');
  const queue = t('design.components.select.queue');
  const options = SAMPLE.queues.map((name) => (
    <option key={name} value={name}>
      {name}
    </option>
  ));
  return (
    <>
      <Card title={t('design.components.heading.textField')}>
        <div className="grid gap-x-4 gap-y-4.5 sm:grid-cols-2 lg:grid-cols-3">
          <TextField
            label={state(fullName, 'default')}
            placeholder={t('design.components.field.namePlaceholder', {
              name: SAMPLE.placeholderName,
            })}
            data-gallery="field"
            labelAttributes={{ 'data-gallery': 'field-label' }}
          />
          <TextField
            label={state(fullName, 'hover')}
            defaultValue={SAMPLE.hoverValue}
            data-preview="hover"
          />
          <TextField
            label={state(fullName, 'focus')}
            defaultValue={SAMPLE.focusValue}
            data-preview="focus"
          />
          <TextField
            type="email"
            label={state(email, 'error')}
            defaultValue={SAMPLE.emailValue}
            error={t('design.components.field.emailError', { example: SAMPLE.emailExample })}
            data-gallery="field-error"
            statusIconAttributes={{ 'data-gallery': 'field-error-icon' }}
          />
          <TextField
            label={state(t('design.components.field.accountId'), 'disabled')}
            defaultValue={SAMPLE.accountId}
            mono
            disabled
            data-gallery="field-disabled"
          />
          <TextField
            label={state(t('design.components.field.lookup'), 'loading')}
            defaultValue={SAMPLE.accountId}
            mono
            loading
            hint={t('design.components.field.verifying')}
          />
        </div>
      </Card>
      <Card title={t('design.components.heading.select')}>
        <div className="grid gap-x-4 gap-y-4.5 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            label={state(queue, 'default')}
            defaultValue={SAMPLE.queues[2]}
            data-gallery="select"
          >
            {options}
          </Select>
          <Select
            label={state(queue, 'focus')}
            defaultValue={SAMPLE.queues[0]}
            data-preview="focus"
          >
            {options}
          </Select>
          <Select label={state(queue, 'disabled')} defaultValue={SAMPLE.queues[3]} disabled>
            {options}
          </Select>
        </div>
      </Card>
    </>
  );
}

function Selection({ t }: { t: Translate }) {
  const state = (name: 'checked' | 'unchecked' | 'indeterminate' | 'focus' | 'disabled') =>
    t(`design.components.state.${name}`);
  return (
    <Card>
      <div className="grid gap-6 md:grid-cols-3">
        <div className="flex flex-col gap-2.5">
          <h3 className="text-h5 font-bold text-text">{t('design.components.heading.toggle')}</h3>
          <Switch
            label={t('design.components.toggle.autoAssign')}
            defaultChecked
            data-gallery="switch-on"
          />
          <Switch label={t('design.components.toggle.ringSound')} data-gallery="switch" />
          <Switch
            label={t('design.components.toggle.localTime')}
            defaultChecked
            data-preview="focus"
          />
          <Switch label={t('design.components.toggle.recording')} disabled />
        </div>
        <div className="flex flex-col gap-2.5">
          <h3 className="text-h5 font-bold text-text">{t('design.components.heading.checkbox')}</h3>
          <Checkbox label={state('unchecked')} data-gallery="checkbox" />
          <Checkbox label={state('checked')} defaultChecked data-gallery="checkbox-checked" />
          <Checkbox label={state('indeterminate')} indeterminate />
          <Checkbox label={state('focus')} data-preview="focus" />
          <Checkbox label={t('design.components.checkbox.terms')} invalid />
          <Checkbox label={state('disabled')} disabled />
        </div>
        <div className="flex flex-col gap-2.5">
          <h3 className="text-h5 font-bold text-text">{t('design.components.heading.radio')}</h3>
          <Radio name="gallery-channel" label={t('admin.channel.whatsapp')} defaultChecked />
          <Radio name="gallery-channel" label={t('admin.channel.sms')} data-gallery="radio" />
          <Radio
            name="gallery-channel"
            label={
              <>
                {t('admin.channel.voice')}
                {' · '}
                {state('focus')}
              </>
            }
            data-preview="focus"
          />
          <Radio
            name="gallery-channel"
            label={
              <>
                {t('admin.channel.ussd')}
                {' · '}
                {state('disabled')}
              </>
            }
            disabled
          />
        </div>
      </div>
    </Card>
  );
}

function Badges({ t, locale }: { t: Translate; locale: string }) {
  const number = new Intl.NumberFormat(locale);
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.chips')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Chip
            icon="person"
            trailingIcon="expand_more"
            data-gallery="chip"
            iconAttributes={{ 'data-gallery': 'chip-icon' }}
          >
            {t('records.filter.owner')}
          </Chip>
          <Chip icon="flag" trailingIcon="expand_more" data-preview="hover">
            {t('records.filter.status')}
          </Chip>
          <Chip icon="location_on" trailingIcon="expand_more" data-preview="focus">
            {t('records.filter.status')}
          </Chip>
          <Chip trailingIcon="expand_more" active aria-pressed data-gallery="chip-active">
            {t('records.filter.source')}
          </Chip>
          <Chip icon="do_not_disturb_on" trailingIcon="expand_more" disabled>
            {t('records.filter.dnd')}
          </Chip>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.pills')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="info">{t('design.components.pill.open')}</Pill>
          <Pill tone="warning">{t('design.components.pill.pending')}</Pill>
          <Pill tone="danger">{t('design.components.pill.escalated')}</Pill>
          <Pill tone="success" data-gallery="pill-success">
            {t('design.components.pill.resolved')}
          </Pill>
          <Pill tone="neutral">{t('design.components.pill.closed')}</Pill>
          <Pill tone="primary">{t('design.components.sample.newLead')}</Pill>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.consent')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="success" icon="check_circle">
            {t('design.components.consent.whatsapp')}
          </Pill>
          <Pill tone="success" icon="mic">
            {t('design.components.consent.recording')}
          </Pill>
          <Pill tone="danger" icon="do_not_disturb_on">
            {t('design.components.consent.dnd')}
          </Pill>
          <Pill tone="warning" icon="campaign">
            {t('design.components.consent.marketing')}
          </Pill>
          <Pill tone="unknown" icon="help">
            {t('design.components.consent.unknown')}
          </Pill>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.tags')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone="primary" data-gallery="tag">
            {t('design.components.tag.vip')}
          </Tag>
          <Tag tone="accent">{t('design.components.tag.hot')}</Tag>
          <Tag tone="danger">{t('design.components.tag.p1')}</Tag>
          <Tag tone="outline" size="small">
            {t('design.components.tag.vip')}
          </Tag>
          <Tag tone="danger-soft" size="small">
            {t('records.dnd.badge')}
          </Tag>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.counts')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <CountBadge data-gallery="count-badge">{`${number.format(9)}+`}</CountBadge>
          <CountBadge tone="primary">{number.format(12)}</CountBadge>
          <CountBadge>{number.format(3)}</CountBadge>
        </div>
      </div>
    </Card>
  );
}

function Navigation({ t, locale }: { t: Translate; locale: string }) {
  const number = new Intl.NumberFormat(locale);
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.segmented')}</h3>
        <div className="flex flex-wrap items-center gap-4">
          <SegmentedControl
            aria-label={t('design.components.segmented.density')}
            data-gallery="segmented"
            options={[
              {
                value: 'comfortable',
                label: t('design.components.segmented.comfortable'),
                attributes: { 'data-gallery': 'segmented-active' },
              },
              {
                value: 'dense',
                label: t('design.components.segmented.dense'),
                attributes: { 'data-gallery': 'segmented-item' },
              },
            ]}
          />
          <SegmentedControl
            aria-label={t('design.components.segmented.view')}
            options={[
              { value: 'list', label: t('design.components.segmented.list'), icon: 'list' },
              {
                value: 'kanban',
                label: t('design.components.segmented.kanban'),
                icon: 'view_kanban',
              },
            ]}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.tabs')}</h3>
        <Scroller>
          <Tabs
            aria-label={t('design.components.tabs.label')}
            id="gallery-tabs"
            defaultValue="timeline"
            items={[
              {
                value: 'overview',
                label: t('design.components.tabs.overview'),
                attributes: { 'data-gallery': 'tab' },
              },
              {
                value: 'timeline',
                label: t('design.components.tabs.timeline'),
                count: number.format(24),
                attributes: { 'data-gallery': 'tab-active' },
              },
              { value: 'deals', label: t('design.components.tabs.deals'), count: number.format(3) },
              {
                value: 'tickets',
                label: t('design.components.tabs.tickets'),
                count: number.format(2),
              },
            ]}
          />
        </Scroller>
      </div>
    </Card>
  );
}

function People({ t, locale }: { t: Translate; locale: string }) {
  const [first, ...others] = SAMPLE.people;
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.avatars')}</h3>
        <div className="flex flex-wrap items-start gap-4.5">
          <span className="flex flex-col items-center gap-1.5 text-caption text-text-2">
            <Avatar
              name={first}
              locale={locale}
              presence="available"
              label={t('design.components.avatar.available', { name: first })}
              data-gallery="avatar-44"
            />
            {t('design.components.presence.available')}
          </span>
          {others.map((name) => (
            <Avatar key={name} name={name} locale={locale} />
          ))}
          <span className="flex flex-col items-center gap-1.5 text-caption text-text-muted">
            <Avatar
              name={SAMPLE.offline}
              locale={locale}
              presence="offline"
              label={t('design.components.avatar.offline', { name: SAMPLE.offline })}
            />
            {t('design.components.presence.offline')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {SAMPLE.rows.map((name, index) => (
            <Avatar
              key={name}
              name={name}
              locale={locale}
              size={32}
              data-gallery={index === 0 ? 'avatar-32' : undefined}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-h5 font-bold text-text">{t('design.components.heading.kbd')}</h3>
        <div className="flex flex-wrap items-center gap-2 text-text-muted">
          <Kbd data-gallery="kbd">{t('design.components.kbd.search')}</Kbd>
          <Kbd>{t('design.components.kbd.escape')}</Kbd>
        </div>
      </div>
    </Card>
  );
}

export default async function ComponentsPage() {
  const { locale } = await activeLocale();
  const { t } = createTranslator(locale);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-title text-text">{t('design.components.title')}</h1>
        <p className="text-body-md text-text-2">
          {t('design.components.subtitle', { version: DESIGN_VERSION })}
        </p>
      </header>

      <Section label={t('design.components.section.actions')}>
        <Buttons t={t} />
        <CompactButtons t={t} />
      </Section>

      <Section label={t('design.components.section.inputs')}>
        <Inputs t={t} />
      </Section>

      <Section label={t('design.components.section.selection')}>
        <Selection t={t} />
      </Section>

      <Section label={t('design.components.section.badges')}>
        <Badges t={t} locale={locale} />
      </Section>

      <Section label={t('design.components.section.navigation')}>
        <Navigation t={t} locale={locale} />
      </Section>

      <Section label={t('design.components.section.people')}>
        <People t={t} locale={locale} />
      </Section>
    </div>
  );
}
