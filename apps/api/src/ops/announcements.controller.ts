import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  opsAnnouncementDraftSchema,
  opsAnnouncementEditSchema,
  opsAnnouncementSendSchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsAnnouncement,
  type OpsAnnouncementDraft,
  type OpsAnnouncementEdit,
  type OpsAnnouncementList,
  type OpsAnnouncementPreview,
  type OpsAnnouncementSend,
  type OpsAnnouncementTestSent,
  type OpsReasonRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  announcementMailData,
  askToSendAnnouncement,
  cancelAnnouncement,
  createAnnouncement,
  editAnnouncement,
  listAnnouncements,
  readAnnouncement,
  sendAnnouncementTest,
  type MailSealing,
  type SeriousActionServices,
} from '@tipme/database';
import { renderMail } from '@tipme/mail';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function announcementId(raw: string): string {
  if (!UUID.test(raw))
    throw new CodedHttpException(404, 'ANNOUNCEMENT_NOT_FOUND');
  return raw.toLowerCase();
}

/**
 * Staff announcements by email (owner-approved, 14 Nov 2026), all under the sensitive
 * `announcements.send`. Reading, previewing and cancelling need no fresh code (see
 * OPS_FRESH_CODE_EXEMPT: reads write nothing, and stopping must work at once). Writing a draft and
 * sending a test take a fresh code; sending is the serious action `announcement.send`, which a
 * second person approves in Approvals.
 */
@Controller('v1/ops/announcements')
export class OpsAnnouncementsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  @RateLimit('ops_read')
  @OpsPermission('announcements.send')
  async list(): Promise<ApiDataResponse<OpsAnnouncementList>> {
    return { data: await listAnnouncements(this.database.db) };
  }

  @Get(':id')
  @RateLimit('ops_read')
  @OpsPermission('announcements.send')
  async read(
    @Param('id') id: string,
  ): Promise<ApiDataResponse<OpsAnnouncement>> {
    return {
      data: await readAnnouncement(this.database.db, announcementId(id)),
    };
  }

  /**
   * The email exactly as the worker will render it: the same template, the same footer. The
   * settings link points at a stand-in, since each person's own link is signed for them.
   */
  @Post('preview')
  @HttpCode(200)
  @RateLimit('ops_read')
  @OpsPermission('announcements.send')
  preview(
    @Body(new ZodValidationPipe(opsAnnouncementDraftSchema))
    body: OpsAnnouncementDraft,
  ): ApiDataResponse<OpsAnnouncementPreview> {
    const { subject, html, text } = renderMail(
      'announcement',
      announcementMailData(body),
      {
        webOrigin: this.config.WEB_ORIGIN,
        unsubscribeUrl: new URL(
          '/email/unsubscribed?t=preview',
          this.config.WEB_ORIGIN,
        ).toString(),
      },
    );
    return { data: { subject, html, text } };
  }

  @Post()
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('announcements.send')
  async create(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsAnnouncementDraftSchema))
    body: OpsAnnouncementDraft,
  ): Promise<ApiDataResponse<OpsAnnouncement>> {
    return {
      data: await createAnnouncement(this.database.db, {
        staffUserId: ops.userId,
        draft: body,
      }),
    };
  }

  @Put(':id')
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('announcements.send')
  async edit(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsAnnouncementEditSchema))
    body: OpsAnnouncementEdit,
  ): Promise<ApiDataResponse<OpsAnnouncement>> {
    return {
      data: await editAnnouncement(this.database.db, {
        staffUserId: ops.userId,
        id: announcementId(id),
        edit: body,
      }),
    };
  }

  @Post(':id/test')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('announcements.send')
  async test(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<OpsAnnouncementTestSent>> {
    return {
      data: await sendAnnouncementTest(this.database.db, this.sealing, {
        staffUserId: ops.userId,
        id: announcementId(id),
      }),
    };
  }

  @Post(':id/send')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('announcements.send')
  async send(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsAnnouncementSendSchema))
    body: OpsAnnouncementSend,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<OpsSeriousPending | (OpsAnnouncement & OpsActedAlone)>
  > {
    const target = announcementId(id);
    const answer = pendingOr(
      await askToSendAnnouncement(this.database.db, {
        actorId: ops.userId,
        grantId: ops.grantId,
        id: target,
        revision: body.revision,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    if ('pending' in answer) return { data: answer.pending };
    return {
      data: {
        ...(await readAnnouncement(this.database.db, target)),
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RateLimit('ops_request')
  @OpsPermission('announcements.send')
  async cancel(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsAnnouncement>> {
    return {
      data: await cancelAnnouncement(this.database.db, {
        staffUserId: ops.userId,
        id: announcementId(id),
        reason: body.reason,
      }),
    };
  }
}
