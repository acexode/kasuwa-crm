import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { clientKey } from './sign-in-throttle.guard';

/**
 * Who a throttled request is counted against.
 *
 * Getting this wrong in one direction makes the limit bypassable by typing an
 * address; getting it wrong in the other makes a whole cell share one bucket
 * and refuses the sixty-first legitimate sign-in of the minute. Both are worth
 * a test, because neither shows up under a supertest suite where every request
 * arrives from the same loopback address.
 */
function requestWith(peer: string, forwardedFor?: string | string[]): Request {
  return {
    socket: { remoteAddress: peer },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  } as unknown as Request;
}

describe('clientKey', () => {
  it('uses the socket peer when nothing is trusted', () => {
    expect(clientKey(requestWith('203.0.113.7'), 0)).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For entirely at zero hops', () => {
    // The header is attacker-controlled unless something strips it. Reading it
    // "just in case" is how a rate limit becomes decorative: every request
    // picks its own bucket.
    const request = requestWith('203.0.113.7', '1.2.3.4, 5.6.7.8');
    expect(clientKey(request, 0)).toBe('203.0.113.7');
  });

  it('counts hops from the right, where our own proxies appended', () => {
    // Each proxy appends the address it saw, so the rightmost entries are the
    // ones we added and the leftmost is whatever the caller sent.
    const request = requestWith('10.0.0.1', '198.51.100.9, 192.0.2.5, 10.0.0.2');
    expect(clientKey(request, 1)).toBe('10.0.0.2');
    expect(clientKey(request, 2)).toBe('192.0.2.5');
    expect(clientKey(request, 3)).toBe('198.51.100.9');
  });

  it('falls back to the peer when the chain is shorter than the hop count', () => {
    // A misconfiguration must over-throttle, never under-throttle. Taking the
    // leftmost entry here would hand the caller their own bucket.
    const request = requestWith('10.0.0.1', '198.51.100.9');
    expect(clientKey(request, 3)).toBe('10.0.0.1');
  });

  it('falls back to the peer when the header is absent or empty', () => {
    expect(clientKey(requestWith('10.0.0.1'), 2)).toBe('10.0.0.1');
    expect(clientKey(requestWith('10.0.0.1', '   '), 2)).toBe('10.0.0.1');
    expect(clientKey(requestWith('10.0.0.1', ' , , '), 1)).toBe('10.0.0.1');
  });

  it('handles a repeated header, which Node presents as an array', () => {
    const request = requestWith('10.0.0.1', ['198.51.100.9', '10.0.0.2']);
    expect(clientKey(request, 1)).toBe('10.0.0.2');
  });

  it('never returns an empty key', () => {
    expect(clientKey(requestWith(''), 0)).toBe('unknown');
  });
});
