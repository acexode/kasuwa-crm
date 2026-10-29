import {
  Controller,
  Get,
  Header,
  UseFilters,
  UseGuards,
  UseInterceptors,
  Param,
} from '@nestjs/common';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import {
  getConversationFor,
  listConversationsFor,
  listMessagesFor,
} from './conversations.service';

const CACHE_CONTROL = 'Cache-Control';
const NO_STORE = 'no-store';

@Controller('api/v1/programmes/:programmeId')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class InboxProgrammeController {
  /** operationId listConversations */
  @Get('conversations')
  @Header(CACHE_CONTROL, NO_STORE)
  async listConversations(@Param() params: unknown) {
    return listConversationsFor(currentTx(), params);
  }
}

@Controller('api/v1/conversations')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ConversationsController {
  /** operationId listMessages */
  @Get(':conversationId/messages')
  @Header(CACHE_CONTROL, NO_STORE)
  async listMessages(@Param() params: unknown) {
    return listMessagesFor(currentTx(), params);
  }

  /** operationId getConversation */
  @Get(':conversationId')
  @Header(CACHE_CONTROL, NO_STORE)
  async getConversation(@Param() params: unknown) {
    return getConversationFor(currentTx(), params);
  }
}
