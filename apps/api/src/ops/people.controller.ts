import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  opsPeopleQuerySchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsPeoplePage,
  type OpsPeopleQuery,
  type OpsPersonEmail,
  type OpsReasonRequest,
} from '@tipme/contracts';
import { listOpsPeople, recordAudit, revealPersonEmail } from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a list asked for, for the audit row: the filters, and only the length of any search. */
function describe(query: OpsPeopleQuery): string {
  const text = query.q?.trim() ?? '';
  return [
    `page ${query.page} of ${query.perPage}`,
    `sort ${query.sort}`,
    ...(query.plan ? [`plan ${query.plan}`] : []),
    ...(query.pageStatus ? [`page status ${query.pageStatus}`] : []),
    ...(query.payouts ? [`payouts ${query.payouts}`] : []),
    ...(query.joinedFrom ? [`joined from ${query.joinedFrom}`] : []),
    ...(query.joinedTo ? [`joined to ${query.joinedTo}`] : []),
    ...(text ? [`search of ${text.length} characters`] : []),
  ].join(', ');
}

/**
 * People (owner's ask, 14 Nov 2026): every account, a page at a time, for `search.view`. Each list is
 * audited like a search, without what was typed. Money (totals and the most-tips sort) needs
 * `private.view` and is refused, not hidden. Emails stay masked; the full one is a reveal with a
 * reason, as a business contact is.
 */
@Controller('v1/ops/users')
export class OpsPeopleController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @OpsPermission('search.view')
  @Header('Cache-Control', 'private, no-store')
  async list(
    @CurrentOps() ops: OpsContext,
    @Query(new ZodValidationPipe(opsPeopleQuerySchema)) query: OpsPeopleQuery,
  ): Promise<ApiDataResponse<OpsPeoplePage>> {
    const privateView = ops.permissions.has('private.view');
    if (query.sort === 'most_tips' && !privateView)
      throw new CodedHttpException(403, 'FORBIDDEN');
    await recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'people.listed',
      permission: 'search.view',
      subjectType: 'people',
      subjectId: describe(query),
    });
    return {
      data: await listOpsPeople(this.database.db, query, { privateView }),
    };
  }

  /** The full sign-in email: audited with the reason (access-control rule 6). */
  @Post(':id/reveal')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('private.view')
  @Header('Cache-Control', 'private, no-store')
  async reveal(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsPersonEmail>> {
    const found = UUID.test(id)
      ? await revealPersonEmail(this.database.db, {
          staffUserId: ops.userId,
          userId: id,
          reason: body.reason,
        })
      : null;
    if (!found) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: found };
  }
}
