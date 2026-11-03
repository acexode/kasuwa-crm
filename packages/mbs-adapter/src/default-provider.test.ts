import { describe, expect, it } from 'vitest';
import { defaultMbsProvider, NullMbsProvider } from './default-provider';
import { MbsProviderUnavailableError } from './errors';
import { FakeMbsProvider } from './fake';

describe('NullMbsProvider', () => {
  it('refuses submit with a typed provider_unavailable error', async () => {
    await expect(new NullMbsProvider().submit()).rejects.toBeInstanceOf(MbsProviderUnavailableError);
  });

  it('returns no QR payload', () => {
    expect(new NullMbsProvider().qrPayloadForIrn('IRN-ANY')).toBeNull();
  });
});

describe('defaultMbsProvider', () => {
  it('is the fake only when the environment is exactly test', () => {
    expect(defaultMbsProvider('test')).toBeInstanceOf(FakeMbsProvider);
    expect(defaultMbsProvider('development')).toBeInstanceOf(NullMbsProvider);
    expect(defaultMbsProvider('production')).toBeInstanceOf(NullMbsProvider);
  });
});

describe('FakeMbsProvider QR', () => {
  it('owns the QR host for a cleared IRN', () => {
    const provider = new FakeMbsProvider();
    const irn = 'IRN-FAKE-TEST';
    const qr = provider.qrPayloadForIrn(irn);
    expect(qr).toContain(irn);
    expect(qr).toMatch(/^https:\/\//u);
  });
});
