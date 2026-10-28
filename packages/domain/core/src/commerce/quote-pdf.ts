import type { Quote } from './quotes.types';

/**
 * Minimal deterministic quote PDF (T-0167).
 *
 * No new dependency: a hand-built PDF 1.4 byte buffer. Same quote fields always
 * yield the same bytes (no wall-clock, no random ids in the content stream).
 * Identifiers and money only — never an email address or other PII.
 */

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function line(text: string): string {
  return `(${escapePdfText(text)}) Tj T*\n`;
}

/** Build the content stream for one quote. */
export function quotePdfContent(quote: Quote): string {
  const lines: string[] = [
    'BT',
    '/F1 14 Tf',
    '50 780 Td',
    '16 TL',
    line('Kasuwa quote'),
    '/F1 10 Tf',
    '12 TL',
    line(`Quote ${quote.id}`),
    line(`Version ${String(quote.version)}`),
    line(`Status ${quote.status}`),
    line(`Currency ${quote.currency}`),
    line(`Subtotal ${quote.subtotalMinor}`),
    line(`Discount ${quote.discountMinor}`),
    line(`Total ${quote.totalMinor}`),
    line('Lines'),
  ];
  for (const item of quote.lines) {
    lines.push(
      line(
        `${item.productId} qty ${String(item.quantity)} @ ${item.unitAmountMinor}` +
          (item.discountBps > 0 ? ` disc ${String(item.discountBps)}bps` : ''),
      ),
    );
  }
  lines.push('ET');
  return lines.join('\n');
}

/**
 * Serialise a PDF document whose sole page is `content`.
 * Object offsets are computed so the xref is exact.
 */
export function buildPdfFromContent(content: string): Buffer {
  const stream = Buffer.from(content, 'utf8');
  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${String(stream.length)} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += object;
  }
  const xrefStart = Buffer.byteLength(body, 'utf8');
  let xref = `xref\n0 ${String(objects.length + 1)}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n`;
  body += `startxref\n${String(xrefStart)}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

/** Render a quote as a deterministic PDF buffer. */
export function renderQuotePdf(quote: Quote): Buffer {
  return buildPdfFromContent(quotePdfContent(quote));
}
