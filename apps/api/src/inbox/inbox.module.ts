import { Module } from '@nestjs/common';
import { ConversationsController, InboxProgrammeController } from './conversations.controller';

@Module({
  controllers: [InboxProgrammeController, ConversationsController],
})
export class InboxModule {}
