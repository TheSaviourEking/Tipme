import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import type { ApiDataResponse, OpsSearchResult } from '@tipme/contracts';
import { opsSearch, recordAudit } from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/**
 * Admin search (PR-013, PRD v1.1 FR-09), permission `search.view`. Each search is audited with
 * its length only: what staff typed could itself be personal data.
 */
@Controller('v1/ops/search')
export class OpsSearchController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @OpsPermission('search.view')
  @Header('Cache-Control', 'private, no-store')
  async search(
    @CurrentOps() ops: OpsContext,
    @Query('q') raw?: string,
  ): Promise<ApiDataResponse<OpsSearchResult>> {
    const q = typeof raw === 'string' ? raw.trim() : '';
    if (q.length < 2 || q.length > 100)
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    await recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'search.performed',
      permission: 'search.view',
      subjectType: 'search',
      subjectId: `${q.length} characters`,
    });
    return { data: await opsSearch(this.database.db, q) };
  }
}
