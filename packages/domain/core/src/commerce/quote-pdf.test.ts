import { describe, expect, it } from 'vitest';
import { buildPdfFromContent, quotePdfContent, renderQuotePdf } from './quote-pdf';
import type { Quote } from './quotes.types';

const quote: Quote = {
  id: '11111111-0000-4000-8000-0000001d0001',
  programmeId: '11111111-0000-4000-8000-0000000c0001',
  dealId: null,
  contactId: null,
  currency: 'NGN',
  status: 'draft',
  discountBps: 0,
  validUntil: null,
  version: 1,
  lines: [
    {
      id: 'l1',
      productId: '11111111-0000-4000-8000-0000001a0001',
      variantId: null,
      quantity: 2,
      unitAmountMinor: '25000000',
      discountBps: 100,
      sortOrder: 0,
    },
  ],
  subtotalMinor: '50000000',
  discountMinor: '500000',
  totalMinor: '49500000',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('quote PDF (T-0167)', () => {
  it('is a PDF and is deterministic for the same quote', () => {
    const a = renderQuotePdf(quote);
    const b = renderQuotePdf(quote);
    expect(a.equals(b)).toBe(true);
    expect(a.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(a.includes(Buffer.from('%%EOF'))).toBe(true);
  });

  it('embeds quote id, money and line product id — never an email', () => {
    const content = quotePdfContent(quote);
    expect(content).toContain(quote.id);
    expect(content).toContain('49500000');
    expect(content).toContain(quote.lines[0]!.productId);
    // Identifiers and money only — no recipient address in the stream.
    expect(content).not.toMatch(/[^\s]@[^\s]/);
    expect(content.toLowerCase()).not.toContain('mailto');
  });

  it('escapes PDF string delimiters in content', () => {
    const pdf = buildPdfFromContent('BT (hello (world)) Tj ET');
    expect(pdf.includes(Buffer.from('(hello (world))'))).toBe(true);
  });
});
