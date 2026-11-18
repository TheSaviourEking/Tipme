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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  opsHandoverAccountsQuerySchema,
  opsHandoverAssignSchema,
  opsReasonSchema,
  opsTakeBackRequestSchema,
  opsUsernameReserveSchema,
  opsUsernamesQuerySchema,
  type ApiDataResponse,
  type OpsHandoverAccount,
  type OpsHandoverAccountsQuery,
  type OpsHandoverAssignRequest,
  type OpsHandoverLink,
  type OpsHandoverLinkCreated,
  type OpsReasonRequest,
  type OpsReservation,
  type OpsSeriousPending,
  type OpsTakeBack,
  type OpsTakeBackRequest,
  type OpsUsernameCheck,
  type OpsUsernameReserveRequest,
  type OpsUsernamesList,
  type OpsUsernamesQuery,
  type UsernameHandedOver,
} from '@tipme/contracts';
import {
  assignUsername,
  cancelHandoverLink,
  cancelTakeBack,
  createHandoverLink,
  findHandoverAccounts,
  recordAudit,
  checkUsername,
  listUsernames,
  releaseUsername,
  requestTakeBack,
  reserveUsername,
  takeBackView,
  type MailSealing,
  type SeriousActionServices,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { FreshCode } from './fresh-code.guard.js';
import { OpsPermission } from './permission.decorator.js';

/**
 * Staff reserve and release usernames (username reservation spec, section 4). Every route needs
 * `usernames.manage` and a fresh code, whatever the screens show; reserve and release are instant
 * and audited. Reads count against `ops_read`, asks against `ops_request` (ruling, 5 Nov 2026). Sign-up and handle changes then refuse a reserved name (profiles.ts).
 * Taking a name back from a page is the serious action `username.take_back`: it waits for a
 * second person when one exists. Cancelling one is instant.
 *
 * Handover (owner's approval, 18 Nov 2026): a reserved name goes to one account, by a one-time
 * claim link (shown once; staff send it themselves) or by giving it to an account staff find. No
 * second person: nobody loses a name. The same permission and fresh code; every step audited.
 */
@Controller('v1/ops/usernames')
export class OpsUsernamesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
  ) {}

  @Get()
  @RateLimit('ops_read')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async list(
    @Query(new ZodValidationPipe(opsUsernamesQuerySchema))
    query: OpsUsernamesQuery,
  ): Promise<ApiDataResponse<OpsUsernamesList>> {
    return {
      data: await listUsernames(this.database.db, {
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.state === undefined ? {} : { state: query.state }),
      }),
    };
  }

  @Get('check/:name')
  @RateLimit('ops_read')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async check(
    @Param('name') name: string,
  ): Promise<ApiDataResponse<OpsUsernameCheck>> {
    const answer = await checkUsername(this.database.db, name, new Date());
    if (answer.state !== 'page' || !answer.facts) return { data: answer };
    // Named on its own in the list: a page that changes its username loses live checkout.
    const listed = this.config.LIVE_CHECKOUT_HANDLES;
    const liveCheckoutListed =
      Array.isArray(listed) &&
      listed.includes(answer.page.handle.toLowerCase());
    return {
      data: { ...answer, facts: { ...answer.facts, liveCheckoutListed } },
    };
  }

  @Post()
  @HttpCode(201)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async reserve(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsUsernameReserveSchema))
    body: OpsUsernameReserveRequest,
  ): Promise<ApiDataResponse<OpsReservation>> {
    return {
      data: await reserveUsername(this.database.db, {
        staffId: ops.userId,
        name: body.name,
        reason: body.reason,
      }),
    };
  }

  @Post(':name/release')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async release(
    @CurrentOps() ops: OpsContext,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ name: string }>> {
    return {
      data: await releaseUsername(this.database.db, {
        staffId: ops.userId,
        name,
        reason: body.reason,
      }),
    };
  }

  @Post(':name/take-back')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async takeBack(
    @CurrentOps() ops: OpsContext,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(opsTakeBackRequestSchema))
    body: OpsTakeBackRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<
      OpsSeriousPending | { takeBack: OpsTakeBack; actedAlone: true }
    >
  > {
    const answer = pendingOr<{
      takeBackId: string;
      revalidateHandles: string[];
    }>(
      await requestTakeBack(this.database.db, {
        actorId: ops.userId,
        grantId: ops.grantId,
        name,
        profileId: body.profileId,
        category: body.category,
        noticeDays: body.noticeDays,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    if ('pending' in answer) return { data: answer.pending };
    // After the commit: only a take-back that completes at once changes a public page.
    for (const handle of answer.result.revalidateHandles)
      this.revalidator.revalidate(handle);
    const takeBack = await takeBackView(
      this.database.db,
      answer.result.takeBackId,
    );
    if (!takeBack) throw new CodedHttpException(404, 'TAKE_BACK_NOT_FOUND');
    return { data: { takeBack, actedAlone: true } };
  }

  @Post('take-backs/:id/cancel')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async cancelTakeBack(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsTakeBack>> {
    return {
      data: await cancelTakeBack(this.database.db, {
        staffId: ops.userId,
        takeBackId: id,
        reason: body.reason,
        sealing: this.sealing,
      }),
    };
  }

  /** Shown once: the answer carries the link's path with its code; the server keeps its hash. */
  @Post(':name/handover-link')
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async createHandoverLink(
    @CurrentOps() ops: OpsContext,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsHandoverLinkCreated>> {
    return {
      data: await createHandoverLink(this.database.db, {
        staffId: ops.userId,
        name,
        reason: body.reason,
      }),
    };
  }

  @Post(':name/handover-link/cancel')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async cancelHandoverLink(
    @CurrentOps() ops: OpsContext,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsHandoverLink>> {
    return {
      data: await cancelHandoverLink(this.database.db, {
        staffId: ops.userId,
        name,
        reason: body.reason,
      }),
    };
  }

  /**
   * Finds the account to give a name to, by its current username or whole confirmed email. The
   * query travels in the body, never the URL, and is audited by its length only, as admin search:
   * what staff typed could be an email address. The answer has no email.
   */
  @Post('handover-accounts')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ops_read')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async handoverAccounts(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsHandoverAccountsQuerySchema))
    body: OpsHandoverAccountsQuery,
  ): Promise<ApiDataResponse<OpsHandoverAccount[]>> {
    await recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'username.account_lookup',
      permission: 'usernames.manage',
      subjectType: 'search',
      subjectId: `${body.query.length} characters`,
    });
    const listed = this.config.LIVE_CHECKOUT_HANDLES;
    const accounts = await findHandoverAccounts(this.database.db, body.query);
    return {
      data: accounts.map((account) => ({
        ...account,
        // Named on its own in the list: a page that changes its username loses live checkout.
        liveCheckoutListed:
          account.page !== null &&
          Array.isArray(listed) &&
          listed.includes(account.page.handle.toLowerCase()),
      })),
    };
  }

  /** Gives a reserved name to an account, with a reason; its old username keeps redirecting. */
  @Post(':name/assign')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async assign(
    @CurrentOps() ops: OpsContext,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(opsHandoverAssignSchema))
    body: OpsHandoverAssignRequest,
  ): Promise<ApiDataResponse<UsernameHandedOver>> {
    const given = await assignUsername(this.database.db, {
      staffId: ops.userId,
      name,
      userId: body.userId,
      reason: body.reason,
    });
    // After the commit: the old page address now redirects, and the name is a page.
    if (given.previous) this.revalidator.revalidateGone(given.previous);
    this.revalidator.revalidate(given.handle);
    return { data: given };
  }
}
