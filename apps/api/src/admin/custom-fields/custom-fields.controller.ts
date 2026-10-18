import { Body, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import {
  createCustomFieldDefinition,
  CUSTOM_FIELD_LIMITS,
  findCustomFieldDefinition,
  listCustomFieldDefinitions,
  retireCustomFieldDefinition,
  updateCustomFieldDefinition,
  type CustomFieldDefinition,
  type CustomFieldDefinitionChanges,
  type CustomFieldType,
} from '@kasuwa/metadata-engine';
import { currentTx } from '../../tenancy/tenant-context';
import {
  AUDIT_CHANGE_VALUE_MAX_LENGTH,
  change,
  recordAuditEvent,
  redactedChange,
  type AuditChange,
} from '../audit/audit-writer';
import { AdminController } from '../common/admin-controller.decorator';
import { AdminError, notFound, validationFailed } from '../common/admin-errors';
import { parseIdOr404, parseOr400 } from '../common/admin-input';
import { requireTenantPermission } from '../common/admin-permissions';
import {
  createConfig,
  CreateCustomFieldBody,
  CustomFieldIdParam,
  ListCustomFieldsQuery,
  planValues,
  toCustomFieldDefinitionWire,
  UpdateCustomFieldBody,
  type CustomFieldDefinitionWire,
} from './custom-fields.schemas';

/**
 * Custom field definitions on the four standard objects, studio screen P18/B
 * (T-0088 contract, served by T-0089; ADR-0016 items 4 and 9; D-L128, D-L138,
 * D-L139, D-L140, D-L141).
 *
 * OpenAPI: docs/api/admin.openapi.yaml, `listCustomFields`,
 * `createCustomField`, `updateCustomField`, `retireCustomField`.
 *
 * TENANT-WIDE, NOT PROGRAMME-WIDE (ADR-0008): a definition is the tenant's,
 * so there is no programme anywhere here, and a `programmeId` in a body is a
 * 400 (the bodies are closed). The VALUES live on the records and are
 * programme-scoped by the row (records API, custom-fields/custom-values.ts).
 *
 * CHECK ORDER (D-L140), on every write: 401 (the guard), then 403
 * `custom_field.write` (the tenant-admin flag, whatever sets the caller
 * holds, D-L53), then 404 (one body: another tenant's field, a standard
 * field, a custom object's field, an id that names nothing or is not an id),
 * then 400 (`field_retired`, then the body), then 409. A caller without the
 * permission never learns whether a field exists or is retired.
 *
 * AUDIT: one event per successful write, `objectType: custom_field`,
 * `programmeId: null`. A refused write throws before anything is written, so
 * it is never audited; a repeat retire writes nothing. Retire is `updated`
 * with a `retiredAt` change (D-L141). Never a record value.
 *
 * There is no delete route (A7): a custom field of a standard object is
 * retired, and 0039's restrictive policy refuses kasuwa_app a DELETE anyway.
 */

const fieldLimitReached = () =>
  new AdminError(HttpStatus.CONFLICT, 'limit_reached', 'This object has reached its custom field limit.', {
    details: [{ path: 'objectApiName', code: 'field_limit_reached' }],
  });

const picklistLimitReached = () =>
  new AdminError(HttpStatus.CONFLICT, 'limit_reached', 'This picklist has reached its value limit.', {
    details: [{ path: 'addValues', code: 'picklist_limit_reached' }],
  });

/** One body for a live or a retired name: it never names the field or says it is retired. */
const duplicateApiName = () =>
  new AdminError(HttpStatus.CONFLICT, 'duplicate_code', 'That API name is already in use on this object.', {
    details: [{ path: 'apiName', code: 'duplicate' }],
  });

const fieldRetired = () => validationFailed([{ path: 'fieldId', code: 'field_retired' }]);

/** A configuration value, kept only when it fits the audit writer's bound; otherwise by name. */
function boundedChange(field: string, before: string | null, after: string | null): AuditChange {
  const fits = (value: string | null) => value === null || value.length <= AUDIT_CHANGE_VALUE_MAX_LENGTH;
  return fits(before) && fits(after) ? change(field, before, after) : redactedChange(field);
}

function auditLabel(definition: CustomFieldDefinition): string {
  return `${definition.objectApiName}.${definition.apiName}`;
}

/** A field this API manages, or the one 404. Asked only after the 403. */
async function managedField(
  tx: TenantTx,
  params: unknown,
  options: { forUpdate?: boolean } = {},
): Promise<CustomFieldDefinition> {
  const { fieldId } = parseIdOr404(CustomFieldIdParam, params);
  const definition = await findCustomFieldDefinition(tx, fieldId, options);
  if (definition === null) throw notFound();
  return definition;
}

@AdminController('api/v1/admin/custom-fields')
export class CustomFieldsController {
  /**
   * operationId: listCustomFields
   * GET /api/v1/admin/custom-fields?object=&includeRetired=
   * 200: CustomFieldList. 400 (an object outside the four, or none). 401. 404
   * (the tenant has no standard definition of the object). No permission:
   * every user of the tenant reads the definitions (they carry no value).
   */
  @Get()
  async list(@Query() query: unknown): Promise<{
    objectApiName: string;
    limits: typeof CUSTOM_FIELD_LIMITS;
    items: CustomFieldDefinitionWire[];
  }> {
    const { object, includeRetired } = parseOr400(ListCustomFieldsQuery, query);
    const definitions = await listCustomFieldDefinitions(currentTx(), object, includeRetired ?? false);
    if (definitions === null) throw notFound();
    return {
      objectApiName: object,
      limits: { ...CUSTOM_FIELD_LIMITS },
      items: definitions.map(toCustomFieldDefinitionWire),
    };
  }

  /**
   * operationId: createCustomField
   * POST /api/v1/admin/custom-fields
   * 201: CustomFieldDefinition. 400 (invalid_api_name, unsupported_type,
   * invalid_config, unknown_currency, duplicate_value, a closed-body key).
   * 401. 403 (no `custom_field.write`, before the body). 404 (no such
   * object in the tenant). 409 duplicate_code / limit_reached.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<CustomFieldDefinitionWire> {
    const tx = currentTx();
    await requireTenantPermission(tx, 'custom_field.write'); // 403
    const parsed = parseOr400(CreateCustomFieldBody, body); // 400
    const type = parsed.type as CustomFieldType;
    const config = createConfig(type, parsed.config);
    if (!config.ok) throw validationFailed(config.details); // 400

    const result = await createCustomFieldDefinition(tx, {
      objectApiName: parsed.objectApiName,
      apiName: parsed.apiName,
      label: parsed.label,
      description: parsed.description ?? null,
      type,
      classification: parsed.classification,
      config: config.config,
    });
    switch (result.kind) {
      case 'no_object':
        throw notFound();
      case 'duplicate':
        throw duplicateApiName(); // 409
      case 'limit_reached':
        throw fieldLimitReached(); // 409
      case 'created': {
        const definition = result.definition;
        await recordAuditEvent(tx, {
          action: 'created',
          objectType: 'custom_field',
          objectId: definition.id,
          objectLabel: auditLabel(definition),
          programmeId: null,
          changes: [
            change('objectApiName', null, definition.objectApiName),
            change('apiName', null, definition.apiName),
            change('type', null, definition.type),
            change('classification', null, definition.classification),
          ],
        });
        return toCustomFieldDefinitionWire(definition);
      }
    }
  }

  /**
   * operationId: updateCustomField
   * PATCH /api/v1/admin/custom-fields/{fieldId}
   * 200: CustomFieldDefinition. 401. 403. 404. 400 (field_retired at
   * fieldId, then the body: not_a_picklist, unknown_value, duplicate_value,
   * a closed-body key, an empty body). 409 picklist_limit_reached.
   * Reclassifying never rewrites the field-security matrix (D-L138).
   */
  @Patch(':fieldId')
  async update(@Param() params: unknown, @Body() body: unknown): Promise<CustomFieldDefinitionWire> {
    const tx = currentTx();
    await requireTenantPermission(tx, 'custom_field.write'); // 403
    const current = await managedField(tx, params, { forUpdate: true }); // 404
    if (current.retiredAt !== null) throw fieldRetired(); // 400
    const parsed = parseOr400(UpdateCustomFieldBody, body); // 400
    const plan = planValues(current, parsed);
    if (plan.kind === 'invalid') throw validationFailed(plan.details); // 400
    if (plan.kind === 'limit_reached') throw picklistLimitReached(); // 409

    const changes: CustomFieldDefinitionChanges = {
      label: parsed.label,
      description: parsed.description,
      classification: parsed.classification,
      config: plan.kind === 'changed' ? plan.config : undefined,
    };
    const updated = await updateCustomFieldDefinition(tx, current.id, changes);
    if (updated === null) throw notFound(); // the row went between the lock and here: impossible

    const audit: AuditChange[] = [];
    if (parsed.label !== undefined && parsed.label !== current.label) {
      audit.push(boundedChange('label', current.label, parsed.label));
    }
    if (parsed.description !== undefined && parsed.description !== current.description) {
      audit.push(boundedChange('description', current.description, parsed.description));
    }
    if (parsed.classification !== undefined && parsed.classification !== current.classification) {
      audit.push(change('classification', current.classification, parsed.classification));
    }
    if (plan.kind === 'changed' && plan.added.length > 0) {
      audit.push(boundedChange('addValues', null, plan.added.join(', ')));
    }
    if (plan.kind === 'changed' && plan.relabelled.length > 0) {
      audit.push(boundedChange('relabelValues', null, plan.relabelled.join(', ')));
    }
    await recordAuditEvent(tx, {
      action: 'updated',
      objectType: 'custom_field',
      objectId: updated.id,
      objectLabel: auditLabel(updated),
      programmeId: null,
      changes: audit,
    });
    return toCustomFieldDefinitionWire(updated);
  }

  /**
   * operationId: retireCustomField
   * POST /api/v1/admin/custom-fields/{fieldId}/retire
   * 200: CustomFieldDefinition with `retiredAt`. 401. 403. 404. A repeat
   * answers 200 with the first `retiredAt` and writes no event, only after
   * the 403 and 404 (D-L140). There is no restore.
   */
  @Post(':fieldId/retire')
  @HttpCode(HttpStatus.OK)
  async retire(@Param() params: unknown): Promise<CustomFieldDefinitionWire> {
    const tx = currentTx();
    await requireTenantPermission(tx, 'custom_field.write'); // 403
    const current = await managedField(tx, params, { forUpdate: true }); // 404
    if (current.retiredAt !== null) return toCustomFieldDefinitionWire(current); // repeat: unchanged

    const retired = await retireCustomFieldDefinition(tx, current.id);
    if (retired === null || retired.retiredAt === null) throw notFound(); // impossible under the lock
    await recordAuditEvent(tx, {
      action: 'updated',
      objectType: 'custom_field',
      objectId: retired.id,
      objectLabel: auditLabel(retired),
      programmeId: null,
      changes: [change('retiredAt', null, retired.retiredAt.toISOString())],
    });
    return toCustomFieldDefinitionWire(retired);
  }
}
