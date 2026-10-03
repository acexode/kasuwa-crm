import { describe, expect, it } from 'vitest';
import {
  currentBillingPeriod,
  dataRegionForCell,
  deriveSetupHealth,
  HEALTH_OUT_OF,
  localeCountry,
  rollUpBadges,
} from './home.rules';

const NOW = new Date('2026-10-03T09:15:00.000Z');

describe('deriveSetupHealth', () => {
  it('scores full marks with nothing failing, and every passing check is worth 0', () => {
    const health = deriveSetupHealth(
      { usersWithoutMfa: 0, dangerAlerts: 0, warningAlerts: 0 },
      NOW,
    );
    expect(health.score).toBe(HEALTH_OUT_OF);
    expect(health.outOf).toBe(HEALTH_OUT_OF);
    expect(health.pointsAvailable).toBe(0);
    expect(health.checkedAt).toBe('2026-10-03T09:15:00.000Z');
    for (const check of health.checks) {
      expect(check.status).toBe('pass');
      expect(check.points).toBe(0);
    }
  });

  it('subtracts each failing rule’s weight, and score + pointsAvailable is always outOf', () => {
    const health = deriveSetupHealth(
      { usersWithoutMfa: 2, dangerAlerts: 1, warningAlerts: 0 },
      NOW,
    );
    const byId = new Map(health.checks.map((check) => [check.checkId, check]));
    expect(byId.get('users_without_mfa')).toMatchObject({
      status: 'warn',
      points: 40,
      label: '2 users without MFA',
      settingId: 'u-mfa',
    });
    expect(byId.get('open_critical_alerts')).toMatchObject({
      status: 'fail',
      points: 35,
      label: '1 critical alert open',
    });
    expect(byId.get('open_warning_alerts')).toMatchObject({ status: 'pass', points: 0 });
    expect(health.score).toBe(HEALTH_OUT_OF - 75);
    expect(health.score + health.pointsAvailable).toBe(health.outOf);
  });

  it('never goes below zero with everything failing', () => {
    const health = deriveSetupHealth(
      { usersWithoutMfa: 9, dangerAlerts: 9, warningAlerts: 9 },
      NOW,
    );
    expect(health.score).toBe(0);
    expect(health.pointsAvailable).toBe(HEALTH_OUT_OF);
  });
});

describe('rollUpBadges', () => {
  it('sums one badge per settingId and carries the most severe severity', () => {
    expect(
      rollUpBadges([
        { settingId: 'u-mfa', severity: 'warning', count: 1 },
        { settingId: 'ch-wa', severity: 'info', count: 2 },
        { settingId: 'ch-wa', severity: 'danger', count: 1 },
        { settingId: 'ch-wa', severity: 'warning', count: 1 },
      ]),
    ).toEqual([
      { settingId: 'ch-wa', count: 4, severity: 'danger' },
      { settingId: 'u-mfa', count: 1, severity: 'warning' },
    ]);
  });

  it('never sends a zero badge, and nothing in means nothing out', () => {
    expect(rollUpBadges([{ settingId: 'u-mfa', severity: 'danger', count: 0 }])).toEqual([]);
    expect(rollUpBadges([])).toEqual([]);
  });
});

describe('currentBillingPeriod', () => {
  it('is the UTC calendar month, half-open, with a Z', () => {
    expect(currentBillingPeriod(NOW)).toEqual({
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
    });
  });

  it('rolls over the year in December, and uses UTC rather than local midnight', () => {
    expect(currentBillingPeriod(new Date('2026-12-31T23:30:00.000Z'))).toEqual({
      periodStart: '2026-12-01T00:00:00.000Z',
      periodEnd: '2027-01-01T00:00:00.000Z',
    });
  });
});

describe('dataRegionForCell and localeCountry', () => {
  it('names the region of a known cell and reports an unknown cell as itself', () => {
    expect(dataRegionForCell('za-1')).toEqual({ code: 'af-south-1', displayName: 'South Africa' });
    expect(dataRegionForCell('xx-9')).toEqual({ code: 'xx-9', displayName: 'xx-9' });
  });

  it('takes the region subtag of a locale, or null', () => {
    expect(localeCountry('en-NG')).toBe('NG');
    expect(localeCountry('sw-ke')).toBe('KE');
    expect(localeCountry('en')).toBeNull();
    expect(localeCountry('en-XA')).toBeNull();
  });
});
