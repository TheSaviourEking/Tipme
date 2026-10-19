import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  opsIssueListQuerySchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsIssue,
  type OpsIssueEvidence,
  type OpsIssueListQuery,
  type OpsPrivateDetails,
  type OpsReasonRequest,
} from '@tipme/contracts';
import {
  issueEvidence,
  listIssues,
  recordAudit,
  revealPrivate,
} from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const LOCAL_TRACE_URL = 'http://127.0.0.1:16686/trace/{traceId}';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The issues inbox and its evidence (PR-009). Viewing evidence and revealing details are audited. */
@Controller('v1/ops/issues')
export class OpsIssuesController {
  private readonly traceTemplate: string | null;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {
    this.traceTemplate =
      config.OPS_TRACE_URL_TEMPLATE ??
      (config.NODE_ENV === 'production' ? null : LOCAL_TRACE_URL);
  }

  @Get()
  @OpsPermission('issues.view')
  async list(
    @Query(new ZodValidationPipe(opsIssueListQuerySchema))
    query: OpsIssueListQuery,
  ): Promise<ApiDataResponse<OpsIssue[]>> {
    return {
      data: await listIssues(this.database.db, { ...query, limit: 50 }),
    };
  }

  @Get(':id')
  @OpsPermission('issues.view')
  async evidence(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<OpsIssueEvidence & { traceUrl: string | null }>> {
    const evidence = UUID.test(id)
      ? await issueEvidence(this.database.db, id)
      : null;
    if (!evidence) throw new CodedHttpException(404, 'NOT_FOUND');
    await recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'issue.viewed',
      permission: 'issues.view',
      subjectType: 'issue',
      subjectId: id,
    });
    const traceUrl =
      evidence.traceId && this.traceTemplate
        ? this.traceTemplate.replace('{traceId}', evidence.traceId)
        : null;
    return { data: { ...evidence, traceUrl } };
  }

  @Post(':id/reveal')
  @HttpCode(200)
  @OpsPermission('private.view')
  async reveal(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsPrivateDetails>> {
    const details = UUID.test(id)
      ? await revealPrivate(this.database.db, id)
      : null;
    if (!details) throw new CodedHttpException(404, 'NOT_FOUND');
    await recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'private.revealed',
      permission: 'private.view',
      subjectType: 'issue',
      subjectId: id,
      reason: body.reason,
    });
    return { data: details };
  }
}
