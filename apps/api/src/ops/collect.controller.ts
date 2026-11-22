import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  OPS_COLLECT_EVIDENCE_MAX_BYTES,
  OPS_COLLECT_EVIDENCE_MAX_FILES,
  OPS_COLLECT_EVIDENCE_TYPES,
  OPS_COLLECT_TRANSFER_STATUSES,
  opsCollectEvidenceSchema,
  opsCollectNameRequestSchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsCollectActed,
  type OpsCollectDispute,
  type OpsCollectDisputeDetail,
  type OpsCollectEvidenceRequest,
  type OpsCollectHeld,
  type OpsCollectNameRequest,
  type OpsCollectSameBank,
  type OpsCollectTransfer,
  type OpsCollectTransferStatus,
  type OpsCollectUnclaimed,
  type OpsReasonRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  addDisputeEvidenceFile,
  collectDisputeForStaff,
  collectDisputesForStaff,
  collectHeldMoney,
  collectSameBankHolds,
  collectTransfersForStaff,
  collectUnclaimed,
  disputeForEvidence,
  holdTransferForReview,
  profileIdByHandle,
  requestSeriousAction,
  type SeriousActionServices,
} from '@tipme/database';
import type { BachsProvider, MockProvider } from '@tipme/payments';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import {
  BACHS_PROVIDER_TOKEN,
  PAYMENT_PROVIDER_TOKEN,
} from '../checkout/payment-provider.provider.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

type Acted = ApiDataResponse<
  (OpsCollectActed & OpsActedAlone) | OpsSeriousPending
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_TYPES: ReadonlySet<string> = new Set(OPS_COLLECT_EVIDENCE_TYPES);

/** Whether the bytes start as the type says: a PDF, a PNG or a JPEG. */
function looksLike(type: string, bytes: Buffer): boolean {
  const starts = (signature: number[]) =>
    signature.every((byte, i) => bytes[i] === byte);
  if (type === 'application/pdf') return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
  if (type === 'image/png')
    return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return starts([0xff, 0xd8, 0xff]);
}

/** One evidence file from the request body (no parser handles it), refused past 5 MB. */
async function readEvidence(request: Request): Promise<{
  bytes: Buffer;
  type: (typeof OPS_COLLECT_EVIDENCE_TYPES)[number];
}> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
  if (!EVIDENCE_TYPES.has(type))
    throw new CodedHttpException(415, 'VALIDATION_FAILED');
  if (
    Number(request.headers['content-length'] ?? 0) >
    OPS_COLLECT_EVIDENCE_MAX_BYTES
  )
    throw new CodedHttpException(413, 'PAYLOAD_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > OPS_COLLECT_EVIDENCE_MAX_BYTES)
      throw new CodedHttpException(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0 || !looksLike(type, bytes))
    throw new CodedHttpException(400, 'VALIDATION_FAILED');
  return { bytes, type: type as (typeof OPS_COLLECT_EVIDENCE_TYPES)[number] };
}

/**
 * You collect's staff screens (plan Task 15, spec §9). Reading is `collect.view`, with today's
 * masking: handles, amounts, states and a bank's last four digits, never a partner account, a full
 * account number or anything about a supporter. Each money action is a serious action on
 * `collect.manage` (a second person, a fresh code, a reason); holding a transfer for review only
 * stops money, so one person does it, with a reason and a fresh code, audited. Support's change of
 * a verified name stays on `recoveries.manage` (Task 13). The reserve screen follows Task 11.
 */
@Controller('v1/ops/collect')
export class OpsCollectController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly mock: MockProvider,
    @Inject(BACHS_PROVIDER_TOKEN) private readonly bachs: BachsProvider | null,
  ) {}

  private async ask(
    ops: OpsContext,
    name: string,
    payload: Record<string, unknown>,
    reason: string,
    response: Response,
  ): Promise<Acted> {
    const answer = pendingOr<object>(
      await requestSeriousAction(this.database.db, {
        name,
        payload,
        actorId: ops.userId,
        grantId: ops.grantId,
        reason,
        services: this.services,
      }),
      response,
    );
    if ('pending' in answer) return { data: answer.pending };
    return {
      data: {
        done: true,
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }

  private id(value: string): string {
    if (!UUID.test(value)) throw new CodedHttpException(404, 'NOT_FOUND');
    return value;
  }

  @Get('held')
  @RateLimit('ops_read')
  @OpsPermission('collect.view')
  async held(): Promise<ApiDataResponse<OpsCollectHeld>> {
    return { data: await collectHeldMoney(this.database.db, new Date()) };
  }

  @Get('transfers')
  @RateLimit('ops_read')
  @OpsPermission('collect.view')
  async transfers(
    @Query('status') status?: string,
  ): Promise<ApiDataResponse<OpsCollectTransfer[]>> {
    if (
      status !== undefined &&
      status !== '' &&
      !(OPS_COLLECT_TRANSFER_STATUSES as readonly string[]).includes(status)
    )
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    return {
      data: await collectTransfersForStaff(this.database.db, {
        ...(status ? { status: status as OpsCollectTransferStatus } : {}),
      }),
    };
  }

  @Get('same-bank')
  @RateLimit('ops_read')
  @OpsPermission('collect.view')
  async sameBank(): Promise<ApiDataResponse<OpsCollectSameBank[]>> {
    return { data: await collectSameBankHolds(this.database.db) };
  }

  /** Retry a transfer in review (only from `review`, back to the queue): a second person. */
  @Post('transfers/:id/retry')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('collect.manage')
  retry(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Acted> {
    return this.ask(
      ops,
      'collect_transfer.retry',
      { transferId: this.id(id) },
      body.reason,
      response,
    );
  }

  /** Record a transfer in review as paid, once the partner's read-back by its group confirms it. */
  @Post('transfers/:id/record-paid')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('collect.manage')
  recordPaid(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Acted> {
    return this.ask(
      ops,
      'collect_transfer.record_paid',
      { transferId: this.id(id) },
      body.reason,
      response,
    );
  }

  /** "Send to review": hold a transfer never sent, for a manual check. It only stops money. */
  @Post('transfers/:id/review')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('collect.manage')
  async review(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsCollectActed>> {
    const held = await holdTransferForReview(this.database.db, {
      transferId: this.id(id),
      staffUserId: ops.userId,
      reason: body.reason,
      now: new Date(),
    });
    if (!held) throw new CodedHttpException(409, 'COLLECT_ACTION_REFUSED');
    return { data: { done: true } };
  }

  /** Clear a shared bank account hold on one recipient (Task 13 M3): a second person. */
  @Post('same-bank/:profileId/clear')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('collect.manage')
  clearSameBank(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Acted> {
    return this.ask(
      ops,
      'collect_same_bank.clear',
      { profileId: this.id(profileId) },
      body.reason,
      response,
    );
  }

  @Get('disputes')
  @RateLimit('ops_read')
  @OpsPermission('collect.view')
  async disputes(): Promise<ApiDataResponse<OpsCollectDispute[]>> {
    return { data: await collectDisputesForStaff(this.database.db) };
  }

  @Get('disputes/:id')
  @RateLimit('ops_read')
  @OpsPermission('collect.view')
  async dispute(
    @Param('id') id: string,
  ): Promise<ApiDataResponse<OpsCollectDisputeDetail>> {
    const detail = await collectDisputeForStaff(this.database.db, {
      disputeId: this.id(id),
      now: new Date(),
    });
    if (!detail) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: detail };
  }

  /**
   * One evidence file (PDF, PNG or JPEG, 5 MB at most, five per dispute), sent to the partner now:
   * a document, not money, so it needs no second person; submitting the evidence does.
   */
  @Post('disputes/:id/evidence/files')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('collect.manage')
  async addFile(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<ApiDataResponse<{ files: number }>> {
    const now = new Date();
    const dispute = await disputeForEvidence(
      this.database.db,
      this.id(id),
      now,
    );
    if (!dispute) throw new CodedHttpException(404, 'NOT_FOUND');
    if (dispute.late)
      throw new CodedHttpException(409, 'COLLECT_EVIDENCE_LATE');
    if (!dispute.canSubmit || dispute.files >= OPS_COLLECT_EVIDENCE_MAX_FILES)
      throw new CodedHttpException(409, 'COLLECT_ACTION_REFUSED');
    const file = await readEvidence(request);
    const provider =
      dispute.provider === 'mock'
        ? this.mock
        : dispute.provider === 'bachs'
          ? this.bachs
          : null;
    const upload = provider?.uploadDisputeFile;
    if (!provider || !upload)
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    let fileRef: string;
    try {
      ({ fileRef } = await upload.call(provider, {
        partnerDisputeId: dispute.partnerDisputeId,
        bytes: file.bytes,
        contentType: file.type,
      }));
    } catch {
      // Nothing is recorded; uploading again is safe (a file is not money).
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    }
    return {
      data: await addDisputeEvidenceFile(this.database.db, {
        disputeId: id,
        fileRef,
        contentType: file.type,
        bytes: file.bytes.length,
        staffUserId: ops.userId,
        now,
      }),
    };
  }

  /** Submit the evidence (once, refused after the deadline): a second person. */
  @Post('disputes/:id/evidence')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('collect.manage')
  async evidence(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsCollectEvidenceSchema))
    body: OpsCollectEvidenceRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Acted> {
    const dispute = await disputeForEvidence(
      this.database.db,
      this.id(id),
      new Date(),
    );
    if (!dispute) throw new CodedHttpException(404, 'NOT_FOUND');
    if (dispute.late)
      throw new CodedHttpException(409, 'COLLECT_EVIDENCE_LATE');
    if (!dispute.canSubmit)
      throw new CodedHttpException(409, 'COLLECT_ACTION_REFUSED');
    // The partner's evidence has one general attachment (Task 5's adapter): more can't be sent.
    if (dispute.provider === 'bachs' && dispute.files > 1)
      throw new CodedHttpException(409, 'COLLECT_ACTION_REFUSED');
    return this.ask(
      ops,
      'collect_dispute.evidence',
      { disputeId: id, text: body.text },
      body.reason,
      response,
    );
  }

  /** Release a closed dispute's hold before its 14 days end (P28): a second person. */
  @Post('disputes/:id/release-hold')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('collect.manage')
  releaseHold(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Acted> {
    return this.ask(
      ops,
      'collect_dispute.release_hold',
      { disputeId: this.id(id) },
      body.reason,
      response,
    );
  }

  /** Book a refund the partner paid that TipMe didn't (Task 10 RI3): a second person. */
  @Post('refunds/:tipId/record-paid')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('collect.manage')
  recordRefund(
    @CurrentOps() ops: OpsContext,
    @Param('tipId') tipId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Acted> {
    return this.ask(
      ops,
      'tip_refund.record_paid',
      { tipId: this.id(tipId) },
      body.reason,
      response,
    );
  }

  @Get('unclaimed')
  @RateLimit('ops_read')
  @OpsPermission('collect.view')
  async unclaimed(): Promise<ApiDataResponse<OpsCollectUnclaimed[]>> {
    return { data: await collectUnclaimed(this.database.db, new Date()) };
  }

  /**
   * Support's change of a recipient's verified name (`collect_name.change`, Task 13), after checking
   * it with them: a second person. The name lock stays, and our payment partner checks the new name
   * with their next bank details before anything more is transferred.
   */
  @Post('name')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('recoveries.manage')
  async changeName(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsCollectNameRequestSchema))
    body: OpsCollectNameRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Acted> {
    const profileId = await profileIdByHandle(this.database.db, body.handle);
    if (!profileId) throw new CodedHttpException(404, 'NOT_FOUND');
    return this.ask(
      ops,
      'collect_name.change',
      { profileId, first: body.first, last: body.last },
      body.reason,
      response,
    );
  }
}
