import { createTranslator } from '@kasuwa/i18n';
import { describe, expect, it } from 'vitest';
import { BELL_MESSAGE_IDS, CENTRE_MESSAGE_IDS, LIST_MESSAGE_IDS, errorMessageId, kindLabel, withNotificationMessages } from './message-ids';
import { NOTIFICATION_KINDS } from '../../lib/notifications-api';

describe('the notification bundles', () => {
  const t = createTranslator('en');

  it('names only ids that exist, with no id twice in one bundle', () => {
    for (const ids of [BELL_MESSAGE_IDS, LIST_MESSAGE_IDS, CENTRE_MESSAGE_IDS]) {
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(() => t.t(id, { count: 1, kind: 'x', variant: 'none', actor: 'a', object: 'o' })).not.toThrow();
    }
  });

  it('adds the bell’s words only where the bell is live', () => {
    expect(withNotificationMessages(['app.name'], ['contacts'])).toEqual(['app.name']);
    expect(withNotificationMessages(['app.name'], ['contacts', 'notifications'])).toEqual(['app.name', ...BELL_MESSAGE_IDS, ...LIST_MESSAGE_IDS]);
  });

  it('labels every kind, and keeps the centre’s own words out of the shell’s bundle', () => {
    for (const kind of NOTIFICATION_KINDS) expect(LIST_MESSAGE_IDS).toContain(kindLabel(kind));
    expect(BELL_MESSAGE_IDS).not.toContain('notifications.title');
  });

  it('translates every error code the operations answer, and an unknown one as an internal error', () => {
    expect(errorMessageId('too_many_requests')).toBe('records.error.too_many_requests');
    expect(errorMessageId('network')).toBe('records.error.network');
    expect(errorMessageId('something_new')).toBe('records.error.internal_error');
    for (const code of ['validation_failed', 'not_authenticated', 'too_many_requests', 'network']) expect(LIST_MESSAGE_IDS).toContain(errorMessageId(code));
  });
});
