'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../../icon';
import {
  getFieldSecurityMatrix,
  listPermissionSets,
  type FieldAccessLevel,
  type FieldSecurityMatrix,
  type PermissionSetList,
  type Result,
} from '../../../lib/admin-api';
import type { CustomFieldObject } from '../../../lib/custom-fields-api';
import { ErrorPanel, Skeleton, StillConnecting } from '../panel';
import { useResource } from '../use-resource';

/**
 * P18's field editor, Security tab (T-0142): who may see this one field, per
 * permission set, Hidden / Read / Edit, as the export draws it.
 *
 * It reads and writes the SAME field-security matrix as P02/D (no second
 * source of truth): the cells are this field's row of the matrix, the version
 * is the matrix's, and the editor saves the changed cells with the matrix's own
 * write, one audited cell at a time. Read only when the tab is first opened, so
 * the studio's list costs no extra request on a 256 kbps link.
 *
 * A locked cell (the admin set) is drawn and never changeable. A field the
 * matrix does not list yet says so and links to the matrix.
 */

const LEVELS: readonly { readonly level: FieldAccessLevel; readonly label: MessageId }[] = [
  { level: 'none', label: 'admin.studio.security.hidden' },
  { level: 'read', label: 'admin.studio.security.read' },
  { level: 'edit', label: 'admin.studio.security.edit' },
];

export interface SecurityState {
  readonly version: number;
  /** The level each permission set had when read, by permission set id. */
  readonly original: Readonly<Record<string, FieldAccessLevel>>;
}

async function both(
  object: CustomFieldObject,
  apiName: string,
  signal: AbortSignal,
): Promise<Result<{ sets: PermissionSetList; matrix: FieldSecurityMatrix }>> {
  const [sets, matrix] = await Promise.all([
    listPermissionSets(signal),
    getFieldSecurityMatrix({ object, q: apiName }, signal),
  ]);
  if (!sets.ok) return sets;
  if (!matrix.ok) return matrix;
  return { ok: true, value: { sets: sets.value, matrix: matrix.value } };
}

export function SecurityTab({
  t,
  object,
  apiName,
  changes,
  onChange,
  onLoaded,
}: {
  t: Translator;
  object: CustomFieldObject;
  apiName: string;
  /** The levels the admin has picked and not saved, by permission set id. */
  changes: Readonly<Record<string, FieldAccessLevel>>;
  onChange: (permissionSetId: string, level: FieldAccessLevel | null) => void;
  onLoaded: (state: SecurityState | null) => void;
}) {
  const resource = useResource((signal) => both(object, apiName, signal), [object, apiName]);
  const row = resource.data?.matrix.rows.find((entry) => entry.fieldApiName === apiName) ?? null;

  useEffect(() => {
    if (resource.data === null) return;
    onLoaded(
      row === null
        ? null
        : {
            version: resource.data.matrix.version,
            original: Object.fromEntries(row.cells.map((cell) => [cell.permissionSetId, cell.level])),
          },
    );
  }, [resource.data, row, onLoaded]);

  if (resource.slow) return <StillConnecting t={t} />;
  if (resource.error !== null) return <ErrorPanel t={t} error={resource.error} onRetry={resource.reload} />;
  if (resource.data === null) return <Skeleton rows={4} label={t.t('admin.loading')} />;

  const intro = <p className="text-meta text-text-2">{t.t('admin.studio.security.intro')}</p>;

  if (row === null) {
    return (
      <>
        {intro}
        <div className="flex flex-col items-start gap-2 rounded-10 bg-surface-sunken px-3.5 py-3 text-meta text-text-2">
          <span>{t.t('admin.studio.security.notListed')}</span>
          <Link href="/admin/field-security" className="font-bold text-primary-text underline-offset-2 is-hover:underline">
            {t.t('admin.studio.custom.fieldSecurity')}
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      {intro}
      <div className="flex flex-col overflow-hidden rounded-10 border border-border">
        {resource.data.sets.items.map((set) => {
          const cell = row.cells.find((entry) => entry.permissionSetId === set.permissionSetId);
          if (cell === undefined) return null;
          const pending = changes[set.permissionSetId];
          const level = pending ?? cell.level;
          const changed = pending !== undefined && pending !== cell.level;
          const locked = cell.locked || set.locked;
          return (
            <div
              key={set.permissionSetId}
              className={`flex flex-wrap items-center gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0 ${changed ? 'bg-warning-soft' : ''}`}
            >
              <div className="flex min-w-0 flex-1 basis-28 flex-col">
                <b className="flex items-center gap-1 text-body-sm">
                  {set.label}
                  {locked ? <Icon name="lock" size={15} className="text-text-muted" /> : null}
                </b>
                {set.userCount === null || set.userCount === undefined ? null : (
                  <span className="text-caption font-normal text-text-muted">{t.t('admin.fls.users', { count: set.userCount })}</span>
                )}
              </div>
              <div
                role="radiogroup"
                aria-label={t.t('admin.studio.security.access', { set: set.label })}
                className="flex gap-0.5 rounded-md border border-border bg-surface p-0.5"
              >
                {LEVELS.map((option) => {
                  const on = level === option.level;
                  return (
                    <label
                      key={option.level}
                      className={`relative inline-flex h-control-base min-w-14 items-center justify-center rounded-6 px-2 text-caption font-bold has-[:focus-visible]:ring-focus md:h-control-xs ${
                        on
                          ? option.level === 'none'
                            ? 'bg-text-2 text-surface'
                            : 'bg-primary text-on-primary'
                          : locked
                            ? 'text-disabled-text'
                            : 'cursor-pointer text-text-2 is-hover:bg-surface-sunken'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`fls-${set.permissionSetId}`}
                        value={option.level}
                        checked={on}
                        disabled={locked}
                        onChange={() => onChange(set.permissionSetId, option.level === cell.level ? null : option.level)}
                        className="sr-only"
                      />
                      {t.t(option.label)}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
