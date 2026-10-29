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
import type { ChannelProvider, DndRegister } from '@kasuwa/channel-adapter';
import { AdminErrorFilter } from '../admin/common/admin-errors';
import { CHANNEL, DND_REGISTER } from '../messaging/channel';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import {
  getConversationFor,
  listConversationsFor,
  listMessagesFor,
} from './conversations.service';
import {
  INBOX_TEMPLATES_ENABLED_TOKEN,
  InboxRoutingEnabledGuard,
  InboxTemplatesEnabledGuard,
} from './inbox-flags';
import {
  assignConversationFor,
  createCannedResponseFor,
  createQueueFor,
  listCannedResponsesFor,
  listQueuesFor,
  transferConversationFor,
} from './routing.service';
import { sendMessageFor } from './send-message.service';
import { listTemplatesFor, submitTemplateFor } from './templates.service';

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

  /** operationId listTemplates */
  @Get('message-templates')
  @UseGuards(InboxTemplatesEnabledGuard)
  @Header(CACHE_CONTROL, NO_STORE)
  async listTemplates(@Param() params: unknown) {
    return listTemplatesFor(currentTx(), params);
  }

  /** operationId submitTemplate */
  @Post('message-templates')
  @UseGuards(InboxTemplatesEnabledGuard)
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async submitTemplate(@Param() params: unknown, @Body() body: unknown) {
    return submitTemplateFor(currentTx(), params, body);
  }

  /** operationId listQueues */
  @Get('inbox-queues')
  @UseGuards(InboxRoutingEnabledGuard)
  @Header(CACHE_CONTROL, NO_STORE)
  async listQueues(@Param() params: unknown) {
    return listQueuesFor(currentTx(), params);
  }

  /** operationId createInboxQueue */
  @Post('inbox-queues')
  @UseGuards(InboxRoutingEnabledGuard)
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async createQueue(@Param() params: unknown, @Body() body: unknown) {
    return createQueueFor(currentTx(), params, body);
  }

  /** operationId listCannedResponses */
  @Get('canned-responses')
  @UseGuards(InboxRoutingEnabledGuard)
  @Header(CACHE_CONTROL, NO_STORE)
  async listCannedResponses(@Param() params: unknown) {
    return listCannedResponsesFor(currentTx(), params);
  }

  /** operationId createCannedResponse */
  @Post('canned-responses')
  @UseGuards(InboxRoutingEnabledGuard)
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async createCannedResponse(@Param() params: unknown, @Body() body: unknown) {
    return createCannedResponseFor(currentTx(), params, body);
  }
}

@Controller('api/v1/conversations')
@UseGuards(KasuwaAuthGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class ConversationsController {
  constructor(
    @Inject(CHANNEL) private readonly channel: ChannelProvider,
    @Inject(DND_REGISTER) private readonly dnd: DndRegister,
    @Inject(INBOX_TEMPLATES_ENABLED_TOKEN) private readonly inboxTemplatesEnabled: boolean,
  ) {}

  /** operationId sendMessage */
  @Post(':conversationId/messages')
  @HttpCode(HttpStatus.CREATED)
  @Header(CACHE_CONTROL, NO_STORE)
  async sendMessage(@Param() params: unknown, @Body() body: unknown) {
    return sendMessageFor(currentTx(), this.channel, this.dnd, params, body, {
      inboxTemplatesEnabled: this.inboxTemplatesEnabled,
    });
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

  /** operationId assignConversation */
  @Post(':conversationId/assign')
  @UseGuards(InboxRoutingEnabledGuard)
  @HttpCode(HttpStatus.OK)
  @Header(CACHE_CONTROL, NO_STORE)
  async assignConversation(@Param() params: unknown, @Body() body: unknown) {
    return assignConversationFor(currentTx(), params, body);
  }

  /** operationId transferConversation */
  @Post(':conversationId/transfer')
  @UseGuards(InboxRoutingEnabledGuard)
  @HttpCode(HttpStatus.OK)
  @Header(CACHE_CONTROL, NO_STORE)
  async transferConversation(@Param() params: unknown, @Body() body: unknown) {
    return transferConversationFor(currentTx(), params, body);
  }
}
