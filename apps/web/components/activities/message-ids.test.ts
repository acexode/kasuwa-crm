import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { RecordsErrorCode } from '../../lib/records-api';
import { ACTIVITIES_MESSAGE_IDS } from './message-ids';
import { BUCKETS, bucketLabel, meetingRuleLabel, snoozeLabel } from './activities-model';

/**
 * A screen that asks for a message id it did not bundle throws — at REQUEST
 * time, on the server, in whichever language the person chose. `tsc` cannot
 * see it, so this reads the SOURCES and checks every literal catalogue id
 * they name is in the bundle the page sends, then the ids a source COMPUTES.
 */

const here = dirname(fileURLToPath(import.meta.url));

function catalogueIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

const SOURCES = [
  'activities-screen.tsx',
  'my-tasks.tsx',
  'activities-calendar.tsx',
  'activity-composer.tsx',
  'reschedule-form.tsx',
  'activity-parts.tsx',
  'activities-model.ts',
  '../records/list-parts.tsx',
  '../crm/crm-shell.tsx',
];

describe('the activities screen bundles every id it renders', () => {
  const available = new Set<string>(ACTIVITIES_MESSAGE_IDS);

  for (const file of SOURCES) {
    it(`${file} names nothing outside ACTIVITIES_MESSAGE_IDS`, () => {
      const named = catalogueIds(file);
      expect(named.length, `${file} names no message id: the scan is reading nothing`).toBeGreaterThan(0);
      // list-parts names the chooser and filter copy this screen never draws.
      const drawn = file === '../records/list-parts.tsx' ? named.filter((id) => id === 'records.locked') : named;
      expect(drawn.filter((id) => !available.has(id))).toEqual([]);
    });
  }

  it('bundles the computed ids a scan cannot see: buckets, empty states, presets, meeting rules, types, errors', () => {
    const computed: string[] = [
      ...BUCKETS.map(bucketLabel),
      ...BUCKETS.map((bucket) => `activities.bucket.empty.${bucket}`),
      ...(['hour', 'tomorrow', 'nextWeek'] as const).map(snoozeLabel),
      ...(['required', 'invalid_range', 'too_long'] as const).map(meetingRuleLabel),
      'record.activity.type.task',
      'record.activity.type.meeting',
      'activities.calendar.week',
      'activities.calendar.month',
      ...RecordsErrorCode.options.map((code) => `records.error.${code}`),
      'records.error.network',
    ];
    expect(computed.filter((id) => !available.has(id))).toEqual([]);
  });

  it('carries the nav entry for /activities, which every CRM screen draws', () => {
    expect(available.has('records.nav.activities')).toBe(true);
  });

  it('resolves in every registered locale', () => {
    for (const locale of REGISTERED_LOCALES) {
      expect(() => bundleMessages(locale, ACTIVITIES_MESSAGE_IDS as readonly MessageId[]), locale).not.toThrow();
    }
  });
});
