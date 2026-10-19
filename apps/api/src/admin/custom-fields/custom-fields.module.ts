import { Module } from '@nestjs/common';
import { CustomFieldsController } from './custom-fields.controller';

/**
 * Admin API: custom field definitions on the standard objects (P18/B,
 * T-0089). Imported by AdminModule, like every admin area (D-L39). No
 * providers of its own: the guard and interceptor resolve PG_POOL and
 * AUTH_MODE globally, and every query runs in the request's tenant
 * transaction.
 */
@Module({ controllers: [CustomFieldsController] })
export class CustomFieldsAdminModule {}
