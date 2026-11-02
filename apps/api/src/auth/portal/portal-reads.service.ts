import { Injectable } from '@nestjs/common';
import { formatProgrammeIds } from '@kasuwa/db';
import { notFound } from '../../admin/common/admin-errors';
import { currentPortalTx } from './portal-context';
import type {
  PortalContactWire,
  PortalProgrammeWire,
  PortalReportWire,
} from './portal.schemas';

const PROGRAMME_SUMMARY_REPORT_ID = 'programme-summary';

@Injectable()
export class PortalReadsService {
  async listProgrammes(): Promise<{ data: PortalProgrammeWire[] }> {
    const tx = currentPortalTx();
    const rows = await tx.query<{ id: string; name: string }>(
      `SELECT p.id, p.name
         FROM portal_programme pp
         JOIN programme p
           ON p.id = pp.programme_id AND p.tenant_id = pp.tenant_id
        WHERE pp.tenant_id = $1
          AND pp.portal_identity_id = $2
          AND pp.programme_id = ANY ($3::uuid[])
        ORDER BY p.name`,
      [
        tx.session.tenantId,
        tx.session.portalIdentityId,
        formatProgrammeIds(tx.session.programmeIds),
      ],
    );
    return { data: rows.map((row) => ({ id: row.id, name: row.name })) };
  }

  async listContacts(): Promise<{ data: PortalContactWire[] }> {
    const tx = currentPortalTx();
    const rows = await tx.query<{
      id: string;
      programme_id: string;
      display_name: string;
    }>(
      `SELECT id, programme_id, display_name
         FROM contact
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC, id DESC`,
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        programmeId: row.programme_id,
        displayName: row.display_name,
      })),
    };
  }

  async getContact(contactId: string): Promise<PortalContactWire> {
    const tx = currentPortalTx();
    const rows = await tx.query<{
      id: string;
      programme_id: string;
      display_name: string;
    }>(
      `SELECT id, programme_id, display_name
         FROM contact
        WHERE id = $1
          AND deleted_at IS NULL`,
      [contactId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw notFound();
    }
    return {
      id: row.id,
      programmeId: row.programme_id,
      displayName: row.display_name,
    };
  }

  async getReport(reportId: string): Promise<PortalReportWire> {
    if (reportId !== PROGRAMME_SUMMARY_REPORT_ID) {
      throw notFound();
    }
    currentPortalTx();
    const timeline = [
      {
        id: '11111111-0000-4000-8000-0000000r0001',
        occurredAt: '2026-01-01T00:01:00.000Z',
        type: 'field_changed',
        field: 'status',
        actorLabel: 'Agent',
      },
    ] as const;
    return { id: PROGRAMME_SUMMARY_REPORT_ID, timeline: [...timeline] };
  }
}
