import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { ChannelProvider } from '@kasuwa/channel-adapter';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { CHANNEL } from '../messaging/channel';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import {
  getConversationFor,
  listConversationsFor,
  listMessagesFor,
} from './conversations.service';
import { sendMessageFor } from './send-message.service';

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
  constructor(@Inject(CHANNEL) private readonly channel: ChannelProvider) {}

  /** operationId sendMessage */
  @Post(':conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async sendMessage(@Param() params: unknown, @Body() body: unknown) {
    return sendMessageFor(currentTx(), this.channel, params, body);
  }

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
