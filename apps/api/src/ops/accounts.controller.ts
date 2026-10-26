import { Controller, Get, Header, Inject, Param, Query } from '@nestjs/common';
import type {
  ApiDataResponse,
  MyTipRow,
  OpsAccountDetail,
  OpsAccountRow,
} from '@tipme/contracts';
import {
  accountDetail,
  listMyTips,
  recordAudit,
  searchAccounts,
} from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Staff look up recipients by handle or name, and open one account (opening is audited).
 * Phone and email are not searchable or shown here; revealing them stays reason-gated.
 */
@Controller('v1/ops/accounts')
export class OpsAccountsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @OpsPermission('issues.view')
  async search(
    @Query('q') q?: string,
  ): Promise<ApiDataResponse<OpsAccountRow[]>> {
    return {
      data: await searchAccounts(this.database.db, {
        query: typeof q === 'string' ? q : '',
      }),
    };
  }

  @Get(':profileId')
  @Header('Cache-Control', 'private, no-store')
  @OpsPermission('issues.view')
  async detail(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
  ): Promise<ApiDataResponse<OpsAccountDetail>> {
    const detail = UUID.test(profileId)
      ? await accountDetail(this.database.db, profileId)
      : null;
    if (!detail) throw new CodedHttpException(404, 'NOT_FOUND');
    await recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'account.viewed',
      permission: 'issues.view',
      subjectType: 'profile',
      subjectId: profileId,
    });
    return { data: detail };
  }

  @Get(':profileId/tips')
  @Header('Cache-Control', 'private, no-store')
  @OpsPermission('issues.view')
  async tips(
    @Param('profileId') profileId: string,
    @Query('q') q?: string,
  ): Promise<
    ApiDataResponse<{ items: MyTipRow[]; nextCursor: string | null }>
  > {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    return {
      data: await listMyTips(this.database.db, profileId, {
        status: 'all',
        limit: 20,
        ...(typeof q === 'string' && q.trim()
          ? { search: q.slice(0, 60) }
          : {}),
      }),
    };
  }
}
