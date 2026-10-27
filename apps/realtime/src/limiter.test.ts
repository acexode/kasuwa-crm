import { describe, expect, it } from 'vitest';
import { InFlightLimiter } from './limiter';

describe('InFlightLimiter', () => {
  it('refuses beyond the cap without calling the task, and frees slots on finish or failure', async () => {
    const limiter = new InFlightLimiter(2);
    const releases: (() => void)[] = [];
    const hold = () => new Promise<string>((resolve) => releases.push(() => resolve('done')));
    const a = limiter.run(hold);
    const b = limiter.run(hold);
    let called = false;
    const refused = await limiter.run(() => {
      called = true;
      return Promise.resolve('x');
    });
    expect(refused).toBeNull();
    expect(called).toBe(false);
    releases.forEach((release) => release());
    expect((await a)?.value).toBe('done');
    expect((await b)?.value).toBe('done');
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect((await limiter.run(() => Promise.resolve(1)))?.value).toBe(1);
  });
});
