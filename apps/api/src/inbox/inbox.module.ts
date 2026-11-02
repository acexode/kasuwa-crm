import { Module, type DynamicModule } from '@nestjs/common';
import {
  INBOX_ROUTING_ENABLED_TOKEN,
  INBOX_TEMPLATES_ENABLED_TOKEN,
  InboxRoutingEnabledGuard,
  InboxTemplatesEnabledGuard,
  inboxRoutingEnabled,
  inboxTemplatesEnabled,
} from './inbox-flags';
import { ConversationsController, InboxProgrammeController } from './conversations.controller';

export interface InboxModuleOptions {
  inboxTemplatesEnabled?: boolean;
  inboxRoutingEnabled?: boolean;
}

@Module({})
export class InboxModule {
  static forRoot(options: InboxModuleOptions = {}): DynamicModule {
    return {
      module: InboxModule,
      controllers: [InboxProgrammeController, ConversationsController],
      providers: [
        InboxTemplatesEnabledGuard,
        InboxRoutingEnabledGuard,
        {
          provide: INBOX_TEMPLATES_ENABLED_TOKEN,
          useValue: inboxTemplatesEnabled(options),
        },
        {
          provide: INBOX_ROUTING_ENABLED_TOKEN,
          useValue: inboxRoutingEnabled(options),
        },
      ],
    };
  }
}
