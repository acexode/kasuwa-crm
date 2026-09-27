import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { findContactById, listContacts, ListContactsQuery } from '@kasuwa/domain-core';
import type { Contact } from '@kasuwa/domain-core';
import { z } from 'zod';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';

const ContactIdParam = z.object({ id: z.string().uuid() });

interface ContactResponse {
  id: string;
  programmeId: string;
  displayName: string;
  givenNames: string | null;
  familyName: string | null;
  phones: { type: string; e164: string }[];
  emails: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The vertical slice's only feature surface.
 *
 * Note what the controller does NOT do: it never reads a tenant id or programme
 * id from the request. Scope arrives through `currentTx()`, which came from the
 * interceptor, which got it from the database. There is no parameter a caller
 * can set to change which rows they see — only which page of their own rows.
 */
@Controller('api/v1/contacts')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
export class ContactsController {
  @Get()
  async list(
    @Query() query: unknown,
  ): Promise<{ data: ContactResponse[]; nextCursor: string | null }> {
    // Zod at the boundary. An invalid limit or a malformed cursor is a 400 via
    // the ZodExceptionFilter, never a silent default.
    const parsed = ListContactsQuery.parse(query);
    const page = await listContacts(currentTx(), parsed);
    return { data: page.data.map(toResponse), nextCursor: page.nextCursor };
  }

  /**
   * Present so that "cannot read another tenant's record via URL manipulation"
   * is an assertion about a real route rather than a hypothetical one.
   * A contact outside the caller's scope is 404, never 403: the existence of a
   * record in another tenant is itself information.
   */
  @Get(':id')
  async findOne(@Param() params: unknown): Promise<ContactResponse> {
    const { id } = ContactIdParam.parse(params);
    const contact = await findContactById(currentTx(), id);
    if (contact === null) {
      throw new NotFoundException('Contact not found');
    }
    return toResponse(contact);
  }
}

function toResponse(contact: Contact): ContactResponse {
  return {
    id: contact.id,
    programmeId: contact.programmeId,
    displayName: contact.displayName,
    givenNames: contact.givenNames,
    familyName: contact.familyName,
    phones: contact.phones,
    emails: contact.emails,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}
