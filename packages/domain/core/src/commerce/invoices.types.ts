import type { CommerceCurrency } from './catalogue.types';
import type { TaxLine } from './tax.types';

export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void', 'overdue'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['issued', 'void'],
  issued: ['paid', 'void', 'overdue'],
  paid: [],
  void: [],
  overdue: ['paid', 'void'],
};

export interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitAmountMinor: string;
}

export interface Invoice {
  id: string;
  programmeId: string;
  quoteId: string | null;
  number: string;
  status: InvoiceStatus;
  currency: CommerceCurrency;
  totalMinor: string;
  taxMinor: string;
  lines: InvoiceLine[];
  taxLines: TaxLine[];
  createdAt: Date;
  updatedAt: Date;
}
