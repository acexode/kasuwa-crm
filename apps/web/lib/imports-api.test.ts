import { describe, expect, it } from 'vitest';
import { isPartUrl } from './imports-api';

const page = { origin: 'https://app.kasuwa.example', hostname: 'app.kasuwa.example' };
const dev = { origin: 'http://localhost:3000', hostname: 'localhost' };

describe('a part URL is somewhere else, over https (N7)', () => {
  it('accepts an absolute https URL on another origin', () => {
    expect(isPartUrl('https://storage.example/kasuwa-imports/upload?part=1&signature=x', page)).toBe(true);
  });

  it('never accepts this page’s own origin, so no CSV is PUT same-origin with the cookie', () => {
    expect(isPartUrl('https://app.kasuwa.example/api/v1/anything', page)).toBe(false);
    expect(isPartUrl('http://localhost:3000/upload', dev)).toBe(false);
  });

  it('refuses a relative, malformed or non-https URL', () => {
    expect(isPartUrl('/upload?part=1', page)).toBe(false);
    expect(isPartUrl('not a url', page)).toBe(false);
    expect(isPartUrl('http://storage.example/upload', page)).toBe(false);
    expect(isPartUrl('javascript:alert(1)', page)).toBe(false);
  });

  it('admits plain http to a loopback host only when the page itself is on one', () => {
    expect(isPartUrl('http://127.0.0.1:59000/bucket/upload', dev)).toBe(true);
    expect(isPartUrl('http://127.0.0.1:59000/bucket/upload', page)).toBe(false);
    expect(isPartUrl('http://storage.example/upload', dev)).toBe(false);
  });
});
