import { Module } from '@nestjs/common';
import { PortalBrandingController } from './portal-branding.controller';

@Module({ controllers: [PortalBrandingController] })
export class AdminPortalBrandingModule {}
