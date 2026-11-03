import { Module, type DynamicModule } from '@nestjs/common';
import {
  ApprovalsController,
  ApprovalsProgrammeController,
  ApprovalsQuoteController,
} from './approvals.controller';
import {
  CataloguePriceBookController,
  CatalogueProductController,
  CatalogueProgrammeController,
} from './catalogue.controller';
import { QuotesController, QuotesProgrammeController } from './quotes.controller';
import {
  PaymentLinksController,
  PaymentLinksQuoteController,
} from './payment-links.controller';
import { PaymentWebhooksController } from '../webhooks/payment-webhooks.controller';
import {
  InvoicesController,
  InvoicesProgrammeController,
  InvoicesQuoteController,
} from './invoices.controller';
import { EinvoiceController } from './einvoice.controller';
import { FxDealController, FxProgrammeController } from './fx.controller';
import {
  BillingScheduleController,
  BillingScheduleInvoiceController,
  BillingScheduleProgrammeController,
} from './billing-schedule.controller';
import {
  MobilePaymentController,
  MobilePaymentInvoiceController,
} from './mobile-payment.controller';

import {
  PAYMENT_LINKS_ENABLED_TOKEN,
  PaymentLinksEnabledGuard,
  paymentLinksEnabled,
} from './payment-links-flag';

import { VAT_MULTITAX_ENABLED_TOKEN, vatMultitaxEnabled } from './vat-flags';

const COMMERCE_MODULE_CONTROLLERS = [
  CatalogueProgrammeController,
  CatalogueProductController,
  CataloguePriceBookController,
  QuotesProgrammeController,
  QuotesController,
  ApprovalsProgrammeController,
  ApprovalsQuoteController,
  ApprovalsController,
  PaymentLinksQuoteController,
  PaymentLinksController,
  PaymentWebhooksController,
  InvoicesProgrammeController,
  InvoicesQuoteController,
  InvoicesController,
  EinvoiceController,
  FxProgrammeController,
  FxDealController,
  BillingScheduleProgrammeController,
  BillingScheduleInvoiceController,
  BillingScheduleController,
  MobilePaymentInvoiceController,
  MobilePaymentController,
];

@Module({})
export class CommerceModule {
  static forRoot(
    options: { paymentLinksEnabled?: boolean; vatMultitaxEnabled?: boolean } = {},
  ): DynamicModule {
    return {
      module: CommerceModule,
      controllers: COMMERCE_MODULE_CONTROLLERS,
      providers: [
        PaymentLinksEnabledGuard,
        { provide: PAYMENT_LINKS_ENABLED_TOKEN, useValue: paymentLinksEnabled(options) },
        // `vat_multitax` (T-0173) reaches the invoice controller.
        { provide: VAT_MULTITAX_ENABLED_TOKEN, useValue: vatMultitaxEnabled(options) },
      ],
    };
  }
}
