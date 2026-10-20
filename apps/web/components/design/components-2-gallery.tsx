'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Banner,
  BottomSheet,
  BulkAction,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  ConfirmPanel,
  Dialog,
  Drawer,
  EmptyState,
  Menu,
  MenuItem,
  MenuPanel,
  MenuSection,
  MenuSeparator,
  Pill,
  Popover,
  SegmentedControl,
  Skeleton,
  SkeletonGroup,
  Stepper,
  Table,
  TableBody,
  TableBulkBar,
  TableCell,
  TableCellTitle,
  TableFooter,
  TableFooterRange,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableSelectCell,
  TableSelectHeader,
  Toast,
  ToastProvider,
  useToast,
  type PillTone,
  type TableDensity,
} from '@kasuwa/ui/components';
import type { IconName } from '@kasuwa/ui';
import { numberingLocale } from '../../lib/numbering';
import { Icon } from '../icon';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';

/**
 * The /design/components-2 gallery (T-0129): every part-2 component in the
 * states the v1.1 Components and Patterns pages draw, laid out like those
 * pages so a reviewer can put them side by side. Overlays appear twice: as
 * in-place specimens (`preview`), the way the design draws them on a scrim
 * tile, and live behind the "Try them" buttons, with focus trap, Esc and
 * focus return.
 *
 * Names, phone numbers and amounts are fixture data, as in a seed; every word
 * of copy is an @kasuwa/i18n string.
 */

type T = ReturnType<typeof createBundleTranslator>['t'];

const SAMPLE = {
  rows: [
    {
      id: 'ao',
      name: 'Adaeze Okonkwo',
      org: 'Ọja Foods Ltd · Lagos',
      phone: '+234 803 555 0142',
      channel: 'whatsapp',
      status: 'open',
      sla: '01:42:10',
      slaTone: 'ok',
      owner: 'Tunde Bakare',
      amount: '1250000.00',
      currency: 'NGN',
      locale: 'en-NG',
    },
    {
      id: 'km',
      name: 'Kwame Mensah',
      org: 'Asante Logistics · Kumasi',
      phone: '+233 24 412 7781',
      channel: 'call',
      status: 'pending',
      sla: '00:12:40',
      slaTone: 'risk',
      owner: 'Efua Owusu',
      amount: '84500.00',
      currency: 'GHS',
      locale: 'en-GH',
    },
    {
      id: 'wk',
      name: 'Wanjiru Kamau',
      org: 'Tusker Retail · Nairobi',
      phone: '+254 712 339 004',
      channel: 'email',
      status: 'escalated',
      sla: '−00:05:12',
      slaTone: 'breach',
      owner: 'Otieno M.',
      amount: '2400000.00',
      currency: 'KES',
      locale: 'en-KE',
    },
    {
      id: 'tn',
      name: 'Thandiwe Nkosi',
      org: 'Ubuntu Insure · Durban',
      phone: '+27 82 555 1934',
      channel: 'sms',
      status: 'resolved',
      sla: '—',
      slaTone: 'none',
      owner: 'Sipho Dlamini',
      amount: '96400.00',
      currency: 'ZAR',
      locale: 'en-ZA',
    },
  ],
  account: 'Ọja Foods Ltd',
  deal: 'Ọja Foods — Q4 supply',
  handOver: 'Chiamaka Eze · Onboarding',
  programme: 'Accra Collections',
  admins: 'Efua Owusu, Kwame Mensah',
  owner: 'Tunde',
  failedNumber: '+254 712…',
  syncedAt: '09:12 WAT',
  wonOn: new Date(Date.UTC(2026, 8, 27)),
  closeOn: new Date(Date.UTC(2026, 9, 31)),
  po: 'PO-2291',
  views: [38, 10, 6, 14, 9, 9],
} as const;

const CHANNEL: Record<string, { readonly icon: IconName; readonly id: MessageId }> = {
  whatsapp: { icon: 'chat', id: 'auth.panel.channel.whatsapp' },
  call: { icon: 'call', id: 'record.activity.type.call' },
  email: { icon: 'mail', id: 'auth.panel.channel.email' },
  sms: { icon: 'sms', id: 'auth.panel.channel.sms' },
};

const STATUS: Record<string, { readonly tone: PillTone; readonly id: MessageId }> = {
  open: { tone: 'info', id: 'design.components.pill.open' },
  pending: { tone: 'warning', id: 'design.components.pill.pending' },
  escalated: { tone: 'danger', id: 'design.components.pill.escalated' },
  resolved: { tone: 'success', id: 'design.components.pill.resolved' },
};

const SLA_TONE: Record<string, string> = {
  ok: 'font-semibold text-success-text',
  risk: 'font-semibold text-warning-text',
  breach: 'font-semibold text-danger-text',
  none: 'text-text-muted',
};

function Section({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-overline text-primary-text">{label}</h2>
      {children}
    </section>
  );
}

/** A static form field as the Patterns specimens draw it: label over a value box. */
function FieldSpecimen({
  label,
  value,
  mono,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-body-sm font-semibold text-text">{label}</span>
      <input
        readOnly
        suppressHydrationWarning
        value={value}
        className={`h-control-base rounded-md border border-border-strong bg-surface px-3 text-body-sm text-text focus:field-focus max-sm:h-control-lg max-sm:text-body-md ${mono === true ? 'font-mono' : ''}`}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------

function DataTable({ t, locale }: { readonly t: T; readonly locale: string }) {
  const [density, setDensity] = useState<TableDensity>('comfortable');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['ao', 'tn']));
  const [perPage, setPerPage] = useState(25);
  const [sort, setSort] = useState<'ascending' | 'descending'>('descending');
  // Node's ICU and the browser's format en-ZA money differently; the amounts
  // are drawn after hydration so the two never disagree.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const number = new Intl.NumberFormat(numberingLocale(locale));
  const all = selected.size === SAMPLE.rows.length;

  function toggle(id: string, on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const rows = sort === 'descending' ? SAMPLE.rows : [...SAMPLE.rows].reverse();
  const count = t('design.components2.table.selected', { count: number.format(selected.size) });

  return (
    <Card
      title={t('design.components2.heading.table')}
      meta={count}
      actions={
        <SegmentedControl
          aria-label={t('design.components2.table.density')}
          value={density}
          onValueChange={(value) => setDensity(value === 'dense' ? 'dense' : 'comfortable')}
          options={[
            { value: 'comfortable', label: t('design.components.segmented.comfortable') },
            { value: 'dense', label: t('design.components.segmented.dense') },
          ]}
        />
      }
    >
      {selected.size > 0 ? (
        <TableBulkBar
          aria-label={t('design.components2.table.bulk')}
          count={count}
          selectAll={{
            label: t('design.components2.table.selectEvery', { count: number.format(1284) }),
            onClick: () => setSelected(new Set(SAMPLE.rows.map((row) => row.id))),
          }}
          actions={
            <>
              <BulkAction icon="person_add">{t('design.components2.bulk.assign')}</BulkAction>
              <BulkAction icon="campaign">{t('design.components2.bulk.campaign')}</BulkAction>
              <BulkAction icon="edit_note">{t('design.components2.bulk.update')}</BulkAction>
            </>
          }
          onClear={() => setSelected(new Set())}
          clearLabel={t('admin.fls.bulk.clear')}
        />
      ) : null}
      <Table
        density={density}
        aria-label={t('design.components2.table.label')}
        scrollClassName="max-h-overlay-preview-frame"
        footer={
          <TableFooter
            summary={
              <>
                {t('design.components2.table.showing')}{' '}
                <TableFooterRange>{`${number.format(1)}–${number.format(perPage)}`}</TableFooterRange>
              </>
            }
            rowsPerPage={{
              label: t('design.components2.table.rowsPerPage'),
              options: [25, 50, 100],
              value: perPage,
              onChange: setPerPage,
            }}
            page={t('design.components2.table.page', { page: number.format(1) })}
            previous={{ label: t('design.components2.table.previous'), onClick: () => undefined, disabled: true }}
            next={{ label: t('design.components2.table.next'), onClick: () => undefined }}
          />
        }
      >
        <TableHead>
          <TableRow>
            <TableSelectHeader
              label={t('design.components2.table.selectPage')}
              checked={all}
              indeterminate={selected.size > 0 && !all}
              onCheckedChange={(on) =>
                setSelected(on ? new Set(SAMPLE.rows.map((row) => row.id)) : new Set())
              }
            />
            <TableHeaderCell
              sort={sort}
              onSort={() => setSort(sort === 'descending' ? 'ascending' : 'descending')}
              className="w-[15rem]"
            >
              {t('activities.related.contact')}
            </TableHeaderCell>
            <TableHeaderCell>{t('records.col.phones')}</TableHeaderCell>
            <TableHeaderCell>{t('admin.sla.col.channel')}</TableHeaderCell>
            <TableHeaderCell>{t('records.filter.status')}</TableHeaderCell>
            <TableHeaderCell>{t('design.components2.table.sla')}</TableHeaderCell>
            <TableHeaderCell>{t('records.filter.owner')}</TableHeaderCell>
            <TableHeaderCell align="end">{t('scripting.builder.field.value')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => {
            const channel = CHANNEL[row.channel];
            const status = STATUS[row.status];
            const on = selected.has(row.id);
            return (
              <TableRow key={row.id} selected={on}>
                <TableSelectCell
                  label={t('design.components2.table.selectRow', { name: row.name })}
                  checked={on}
                  onCheckedChange={(next) => toggle(row.id, next)}
                />
                <TableCell>
                  <TableCellTitle title={row.name} subtitle={density === 'dense' ? undefined : row.org} />
                </TableCell>
                <TableCell numeric align="start">
                  {row.phone}
                </TableCell>
                <TableCell className="text-text-2">
                  {channel === undefined ? null : (
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name={channel.icon} size={18} />
                      {t(channel.id)}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {status === undefined ? null : <Pill tone={status.tone}>{t(status.id)}</Pill>}
                </TableCell>
                <TableCell numeric align="start" className={SLA_TONE[row.slaTone]}>
                  {row.sla}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <bdi>{row.owner}</bdi>
                </TableCell>
                <TableCell numeric>
                  {mounted && new Intl.NumberFormat(numberingLocale(row.locale), { style: 'currency', currency: row.currency }).format(
                    row.amount,
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Menus({ t, locale }: { readonly t: T; readonly locale: string }) {
  const number = new Intl.NumberFormat(numberingLocale(locale));
  const [view, setView] = useState(0);
  const views: readonly MessageId[] = [
    'design.components2.menu.trigger',
    'design.components2.menu.mine',
    'design.components2.menu.whatsapp',
    'design.components2.menu.ussd',
    'design.components2.menu.lagos',
    'design.components2.menu.unassigned',
  ];
  const items = (
    <>
      <MenuSection>{t('design.components2.menu.section')}</MenuSection>
      {views.map((id, index) => (
        <MenuItem
          key={id}
          selected={index === view}
          meta={number.format(SAMPLE.views[index] ?? 0)}
          onSelect={() => setView(index)}
        >
          {t(id)}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem tone="primary" icon="bookmark_add">
        {t('design.components2.menu.save')}
      </MenuItem>
    </>
  );
  const label = views[view] ?? 'design.components2.menu.trigger';

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title={t('design.components2.heading.menu')}>
        <MenuPanel role="menu" aria-label={t('design.components2.menu.section')} className="w-overlay-menu max-w-full">
          {items}
        </MenuPanel>
      </Card>
      <Card title={t('design.components2.heading.live')}>
        <div className="flex flex-wrap items-start gap-3">
          <Menu
            aria-label={t('design.components2.menu.section')}
            trigger={(props) => (
              <Button {...props} size="compact" icon="bookmark" trailingIcon="expand_more">
                {t(label)}
              </Button>
            )}
          >
            {items}
          </Menu>
          <Popover
            aria-label={t('design.components2.popover.label')}
            align="end"
            trigger={(props) => (
              <Button {...props} size="compact" icon="view_column">
                {t('design.components2.popover.trigger')}
              </Button>
            )}
            panelClassName="gap-0.5"
          >
            <MenuSection>{t('design.components2.popover.trigger')}</MenuSection>
            <span className="px-2.5">
              <Checkbox defaultChecked label={t('records.col.phones')} />
            </span>
            <span className="px-2.5">
              <Checkbox defaultChecked label={t('admin.sla.col.channel')} />
            </span>
            <span className="px-2.5">
              <Checkbox label={t('records.filter.owner')} />
            </span>
          </Popover>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Toasts({ t }: { readonly t: T }) {
  return (
    <Card title={t('design.components2.heading.toasts')}>
      <div className="flex flex-col gap-2.5">
        <Toast
          tone="success"
          message={t('design.components2.toast.saved')}
          action={{ label: t('design.components.sample.undo'), onClick: () => undefined }}
        />
        <Toast
          tone="error"
          message={t('design.components2.toast.failed', { number: SAMPLE.failedNumber })}
          action={{ label: t('design.components2.toast.retry'), onClick: () => undefined }}
        />
        <Toast
          tone="info"
          icon="cloud_upload"
          message={t('design.components2.toast.offline')}
          dismissLabel={t('design.components2.toast.dismiss')}
          onDismiss={() => undefined}
        />
        <Toast tone="warning" message={t('design.components2.toast.queue', { percent: '92%' })} />
      </div>
    </Card>
  );
}

function ConfirmSpecimen({ t }: { readonly t: T }) {
  return (
    <div className="relative flex min-h-full items-center justify-center rounded-lg border border-border bg-scrim px-6 py-12">
      <Caption>{t('design.components2.caption.scrim')}</Caption>
      <ConfirmPanel
        role="group"
        titleId="confirm-specimen-title"
        bodyId="confirm-specimen-body"
        icon="delete"
        tone="danger"
        title={t('design.components2.confirm.title')}
        description={t('design.components2.confirm.body')}
        actions={
          <>
            <Button>{t('design.components2.confirm.keep')}</Button>
            <Button variant="danger">{t('design.components.sample.delete')}</Button>
          </>
        }
      />
    </div>
  );
}

function DealFields({ t, locale }: { readonly t: T; readonly locale: string }) {
  const date = new Intl.DateTimeFormat(numberingLocale(locale), { dateStyle: 'medium', timeZone: 'Africa/Lagos' });
  return (
    <>
      <FieldSpecimen label={t('design.components2.drawer.name')} value={SAMPLE.deal} />
      <FieldSpecimen label={t('design.components2.drawer.account')} value={SAMPLE.account} />
      <FieldSpecimen
        label={t('design.components2.drawer.amount')}
        value={new Intl.NumberFormat(numberingLocale('en-NG'), { style: 'currency', currency: 'NGN' }).format(
          '12500000.00',
        )}
        mono
      />
      <FieldSpecimen label={t('design.components2.drawer.closeDate')} value={`${date.format(SAMPLE.closeOn)} · WAT`} />
      <FieldSpecimen
        label={t('design.components2.drawer.stage')}
        value={t('design.components2.drawer.stageValue')}
      />
      <FieldSpecimen label={t('records.filter.owner')} value={SAMPLE.rows[0].owner} />
      <FieldSpecimen label={t('design.components2.drawer.po')} value={SAMPLE.po} mono />
    </>
  );
}

function WonFields({ t, locale }: { readonly t: T; readonly locale: string }) {
  const date = new Intl.DateTimeFormat(numberingLocale(locale), { dateStyle: 'full', timeZone: 'Africa/Lagos' });
  return (
    <>
      <FieldSpecimen
        label={t('design.components2.dialog.amount')}
        value={new Intl.NumberFormat(numberingLocale('en-NG'), { style: 'currency', currency: 'NGN' }).format(
          '12500000.00',
        )}
        mono
      />
      <FieldSpecimen label={t('design.components2.dialog.wonOn')} value={date.format(SAMPLE.wonOn)} />
      <FieldSpecimen
        label={t('design.components2.dialog.reason')}
        value={t('design.components2.dialog.reasonValue')}
      />
      <FieldSpecimen label={t('design.components2.dialog.handOver')} value={SAMPLE.handOver} />
    </>
  );
}

function Caption({ children }: { readonly children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute start-3.5 top-3.5 z-10 text-caption text-on-primary">
      {children}
    </span>
  );
}

function Overlays({ t, locale }: { readonly t: T; readonly locale: string }) {
  const noop = () => undefined;
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-2">
        <Toasts t={t} />
        <ConfirmSpecimen t={t} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="relative h-overlay-preview-frame overflow-hidden rounded-lg border border-border">
          <Caption>{t('design.components2.caption.drawer')}</Caption>
          <Drawer
            preview
            open
            onClose={noop}
            title={t('design.components2.drawer.title')}
            subtitle={SAMPLE.deal}
            closeLabel={t('admin.dialog.close')}
            secondaryAction={<Button variant="ghost">{t('admin.audit.export.cancel')}</Button>}
            primaryAction={<Button variant="primary">{t('record.form.save')}</Button>}
          >
            <DealFields t={t} locale={locale} />
          </Drawer>
        </div>
        <div className="relative h-overlay-preview-frame overflow-hidden rounded-lg border border-border">
          <Dialog
            preview
            open
            onClose={noop}
            title={t('design.components2.dialog.title')}
            description={t('design.components2.dialog.body', { account: SAMPLE.account })}
            closeLabel={t('admin.dialog.close')}
            secondaryAction={<Button>{t('admin.audit.export.cancel')}</Button>}
            primaryAction={<Button variant="primary">{t('design.components2.dialog.markWon')}</Button>}
          >
            <WonFields t={t} locale={locale} />
          </Dialog>
        </div>
      </div>
      <div className="relative h-overlay-preview-frame-compact w-full max-w-overlay-dialog-confirm overflow-hidden rounded-lg border border-border">
        <Caption>{t('design.components2.caption.sheet')}</Caption>
        <BottomSheet
          preview
          open
          onClose={noop}
          title={t('design.components2.drawer.title')}
          closeLabel={t('admin.dialog.close')}
          secondaryAction={<Button>{t('admin.audit.export.cancel')}</Button>}
          primaryAction={<Button variant="primary">{t('record.form.save')}</Button>}
        >
          <DealFields t={t} locale={locale} />
        </BottomSheet>
      </div>
    </>
  );
}

function LiveOverlays({ t, locale }: { readonly t: T; readonly locale: string }) {
  const [open, setOpen] = useState<'dialog' | 'confirm' | 'drawer' | 'sheet' | null>(null);
  const keep = useRef<HTMLButtonElement | null>(null);
  const toast = useToast();
  const close = () => setOpen(null);

  return (
    <Card title={t('design.components2.heading.live')}>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen('dialog')}>{t('design.components2.live.dialog')}</Button>
        <Button onClick={() => setOpen('confirm')}>{t('design.components2.live.confirm')}</Button>
        <Button onClick={() => setOpen('drawer')}>{t('design.components2.live.drawer')}</Button>
        <Button onClick={() => setOpen('sheet')}>{t('design.components2.live.sheet')}</Button>
        <Button
          onClick={() =>
            toast.show({
              tone: 'success',
              message: t('design.components2.toast.saved'),
              action: { label: t('design.components.sample.undo'), onClick: () => undefined },
            })
          }
        >
          {t('design.components2.live.toastSuccess')}
        </Button>
        <Button
          onClick={() =>
            toast.show({
              tone: 'error',
              message: t('design.components2.toast.failed', { number: SAMPLE.failedNumber }),
              dismissLabel: t('design.components2.toast.dismiss'),
            })
          }
        >
          {t('design.components2.live.toastError')}
        </Button>
      </div>
      <Dialog
        open={open === 'dialog'}
        onClose={close}
        title={t('design.components2.dialog.title')}
        description={t('design.components2.dialog.body', { account: SAMPLE.account })}
        closeLabel={t('admin.dialog.close')}
        secondaryAction={<Button onClick={close}>{t('admin.audit.export.cancel')}</Button>}
        primaryAction={
          <Button variant="primary" onClick={close}>
            {t('design.components2.dialog.markWon')}
          </Button>
        }
      >
        <WonFields t={t} locale={locale} />
      </Dialog>
      <ConfirmDialog
        open={open === 'confirm'}
        onClose={close}
        icon="delete"
        title={t('design.components2.confirm.title')}
        description={t('design.components2.confirm.body')}
        initialFocus={keep}
        actions={
          <>
            <Button ref={keep} onClick={close}>
              {t('design.components2.confirm.keep')}
            </Button>
            <Button variant="danger" onClick={close}>
              {t('design.components.sample.delete')}
            </Button>
          </>
        }
      />
      <Drawer
        open={open === 'drawer'}
        onClose={close}
        title={t('design.components2.drawer.title')}
        subtitle={SAMPLE.deal}
        closeLabel={t('admin.dialog.close')}
        secondaryAction={
          <Button variant="ghost" onClick={close}>
            {t('admin.audit.export.cancel')}
          </Button>
        }
        primaryAction={
          <Button variant="primary" onClick={close}>
            {t('record.form.save')}
          </Button>
        }
      >
        <DealFields t={t} locale={locale} />
      </Drawer>
      <BottomSheet
        open={open === 'sheet'}
        onClose={close}
        title={t('design.components2.drawer.title')}
        closeLabel={t('admin.dialog.close')}
        secondaryAction={<Button onClick={close}>{t('admin.audit.export.cancel')}</Button>}
        primaryAction={
          <Button variant="primary" onClick={close}>
            {t('record.form.save')}
          </Button>
        }
      >
        <DealFields t={t} locale={locale} />
      </BottomSheet>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Progress({ t, locale }: { readonly t: T; readonly locale: string }) {
  const number = new Intl.NumberFormat(numberingLocale(locale));
  const steps: readonly { id: MessageId; state: 'done' | 'active' | 'todo' }[] = [
    { id: 'design.components2.stepper.upload', state: 'done' },
    { id: 'design.components2.stepper.map', state: 'done' },
    { id: 'design.components2.stepper.clean', state: 'active' },
    { id: 'design.components2.stepper.review', state: 'todo' },
    { id: 'records.action.import', state: 'todo' },
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title={t('design.components2.heading.stepper')}>
        <Stepper
          label={t('design.components2.stepper.label')}
          steps={steps.map((step) => ({ label: t(step.id), state: step.state }))}
          compactSummary={t('design.components2.stepper.summary', {
            step: number.format(3),
            total: number.format(steps.length),
            label: t('design.components2.stepper.clean'),
          })}
        />
      </Card>
      <Card title={t('design.components2.heading.skeleton')}>
        <SkeletonGroup
          label={t('design.components2.skeleton.label')}
          slowMessage={t('design.components2.skeleton.slow')}
        >
          <div className="flex items-center gap-3">
            <Skeleton shape="circle" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="w-3/5" />
              <Skeleton shape="line-sm" className="w-2/5" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Skeleton shape="circle" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="w-3/4" />
              <Skeleton shape="line-sm" className="w-1/3" />
            </div>
          </div>
          <Skeleton shape="block" />
        </SkeletonGroup>
      </Card>
    </div>
  );
}

function EmptyStates({ t }: { readonly t: T }) {
  const chip = (text: string) => (
    <span className="inline-flex h-8 items-center rounded-6 bg-primary-soft pe-0.5 ps-2.5 text-meta font-semibold text-primary-text">
      {text}
      <button
        type="button"
        aria-label={t('design.components2.empty.removeFilter', { filter: text })}
        className="inline-flex h-8 w-7 items-center justify-center rounded-6 is-focus-visible:ring-focus"
      >
        <Icon name="close" size={18} />
      </button>
    </span>
  );
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card padding="md">
          <EmptyState
            icon="handshake"
            tone="primary"
            eyebrow={t('design.components2.empty.firstUse')}
            title={t('design.components2.empty.firstUseTitle')}
            body={t('design.components2.empty.firstUseBody')}
            action={<Button variant="primary">{t('design.components2.empty.firstUseAction')}</Button>}
            footnote={
              <>
                {t('design.components2.empty.or', { link: '' })}
                <a href="#import" className="text-primary-text underline underline-offset-3">
                  {t('design.components2.empty.importCsv')}
                </a>
              </>
            }
          />
        </Card>
        <Card padding="md">
          <EmptyState
            icon="filter_alt_off"
            tone="neutral"
            eyebrow={t('design.components2.empty.noResults')}
            title={t('design.components2.empty.noResultsTitle')}
            body={t('design.components2.empty.noResultsBody')}
            extra={
              <div className="flex flex-wrap gap-1.5">
                {chip(t('design.components2.empty.filterOwner', { name: SAMPLE.owner }))}
                {chip(t('design.components2.empty.filterClose'))}
              </div>
            }
            action={<Button>{t('admin.audit.clearAll')}</Button>}
          />
        </Card>
        <Card padding="md">
          <EmptyState
            icon="lock"
            tone="neutral"
            eyebrow={t('design.components2.empty.restricted')}
            title={t('design.components2.empty.restrictedTitle', { programme: SAMPLE.programme })}
            body={t('design.components2.empty.restrictedBody', { admins: SAMPLE.admins })}
            action={<Button>{t('design.components2.empty.requestAccess')}</Button>}
          />
        </Card>
        <Card padding="md">
          <EmptyState
            icon="cloud_off"
            tone="info"
            eyebrow={t('design.components2.empty.offline')}
            title={t('design.components2.empty.offlineTitle')}
            body={t('design.components2.empty.offlineBody', { time: SAMPLE.syncedAt })}
            action={<Button>{t('records.retry')}</Button>}
          />
        </Card>
      </div>
      <Card>
        <EmptyState
          align="center"
          icon="inbox"
          tone="primary"
          title={t('design.components2.empty.queueTitle')}
          body={t('design.components2.empty.queueBody', { programme: SAMPLE.programme })}
          action={<Button>{t('design.components2.empty.connect')}</Button>}
          className="py-3"
        />
      </Card>
    </>
  );
}

function Banners({ t, locale }: { readonly t: T; readonly locale: string }) {
  const number = new Intl.NumberFormat(numberingLocale(locale));
  return (
    <div className="flex flex-col gap-2.5">
      <Banner
        tone="offline"
        title={t('design.components2.banner.offlineTitle')}
        action={{
          label: t('design.components2.banner.viewQueue', { count: number.format(7) }),
          onClick: () => undefined,
        }}
      >
        {t('design.components2.banner.offlineBody', { count: number.format(7) })}
      </Banner>
      <Banner tone="info" busy title={t('design.components2.banner.syncingTitle')}>
        {t('design.components2.banner.syncingBody', { done: number.format(3), total: number.format(7) })}
      </Banner>
      <Banner tone="success" title={t('design.components2.banner.syncedTitle')}>
        {t('design.components2.banner.syncedBody')}
      </Banner>
      <Banner tone="warning" title={t('design.components2.banner.warningTitle')}>
        {t('design.components2.banner.warningBody')}
      </Banner>
      <Banner tone="danger" title={t('design.components2.banner.dangerTitle')}>
        {t('design.components2.banner.dangerBody', { count: number.format(2) })}
      </Banner>
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface ComponentsTwoGalleryProps {
  readonly locale: string;
  readonly messages: MessageBundle;
  readonly version: string;
}

export function ComponentsTwoGallery({ locale, messages, version }: ComponentsTwoGalleryProps) {
  const { t } = createBundleTranslator(locale, messages);
  return (
    <ToastProvider label={t('design.components2.toast.region')}>
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6" data-screen="design-components-2">
        <header className="flex flex-col gap-2">
          <h1 className="m-0 text-title text-text">{t('design.components2.title')}</h1>
          <p className="m-0 text-body-md text-text-2">{t('design.components2.subtitle', { version })}</p>
        </header>

        <Section label={t('design.components2.section.data')}>
          <DataTable t={t} locale={locale} />
        </Section>

        <Section label={t('design.components2.section.menus')}>
          <Menus t={t} locale={locale} />
        </Section>

        <Section label={t('design.components2.section.feedback')}>
          <Overlays t={t} locale={locale} />
          <LiveOverlays t={t} locale={locale} />
        </Section>

        <Section label={t('design.components2.section.progress')}>
          <Progress t={t} locale={locale} />
        </Section>

        <Section label={t('design.components2.section.empty')}>
          <EmptyStates t={t} />
        </Section>

        <Section label={t('design.components2.section.connectivity')}>
          <Banners t={t} locale={locale} />
        </Section>
      </div>
    </ToastProvider>
  );
}
