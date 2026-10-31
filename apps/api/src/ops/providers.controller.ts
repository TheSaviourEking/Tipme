import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  mailProviderNameSchema,
  opsMailOverrideRemoveSchema,
  opsMailOverrideSchema,
  opsMailSwitchSchema,
  opsMailTestSchema,
  opsProviderTestConfirmSchema,
  opsSuppressionLookupSchema,
  opsSuppressionRemoveSchema,
  type ApiDataResponse,
  type OpsMailOverrideRemoveRequest,
  type OpsMailOverrideRequest,
  type OpsMailProviders,
  type OpsMailSwitchRequest,
  type OpsMailTestRequest,
  type OpsProviderTestConfirmRequest,
  type OpsSuppressionLookupRequest,
  type OpsSuppressionRemoveRequest,
} from '@tipme/contracts';
import {
  auditSuppressionLookup,
  confirmProviderTest,
  hasConfirmedMailTest,
  findAccountByHandleOrId,
  findSuppression,
  mailProviderOverview,
  removeProviderOverride,
  removeSuppression,
  setProviderOverride,
  startMailProviderTest,
  switchMailProvider,
  verifiedEmailOf,
  type MailSealing,
} from '@tipme/database';
import type {
  MailProvider,
  MailProviderName,
  MailProviderStatus,
} from '@tipme/mail';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import {
  MAIL_PROVIDERS,
  MAIL_SEALING,
  type MailProviders,
} from '../mail/mail-providers.provider.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const STATUS_TIMEOUT_MS = 3000;
const STATUS_CACHE_MS = 60_000;

/** Staff test mail providers, choose the active one, pin accounts and manage suppressions. */
@Controller('v1/ops/providers')
export class OpsProvidersController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(MAIL_PROVIDERS) readonly providers: MailProviders,
  ) {}

  private configured(name: string): MailProvider {
    const parsed = mailProviderNameSchema.safeParse(name);
    const provider = parsed.success
      ? this.providers.get(parsed.data as MailProviderName)
      : undefined;
    if (!provider) throw new CodedHttpException(404, 'NOT_FOUND');
    return provider;
  }

  private readonly statusCache = new Map<
    string,
    { at: number; status: MailProviderStatus | null }
  >();

  /**
   * A provider's own status: at most every minute, and never more than 3 seconds' wait, so a slow
   * provider can't hold up the page or a switch. An error says nothing beyond "unknown".
   */
  private async statusOf(provider: MailProvider, fresh = false) {
    const cached = this.statusCache.get(provider.name);
    if (!fresh && cached && Date.now() - cached.at < STATUS_CACHE_MS)
      return cached.status;
    let timer: NodeJS.Timeout | undefined;
    const status = await Promise.race([
      provider.status().catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STATUS_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    // Unknown isn't remembered, so the next look tries again.
    if (status) this.statusCache.set(provider.name, { at: Date.now(), status });
    return status;
  }

  private production() {
    return (
      this.config.NODE_ENV === 'production' &&
      this.config.DEPLOYMENT_MODE !== 'preview'
    );
  }

  @Get('mail')
  @OpsPermission('issues.view')
  async overview(): Promise<ApiDataResponse<OpsMailProviders>> {
    const overview = await mailProviderOverview(this.database.db, {
      configured: [...this.providers.keys()],
      fallback: this.config.MAIL_DEFAULT_PROVIDER,
    });
    const providers = await Promise.all(
      overview.providers.map(async (card) => {
        const status = await this.statusOf(this.providers.get(card.name)!);
        return {
          ...card,
          sandbox: status?.sandbox ?? null,
          statusDetail: status?.detail ?? null,
        };
      }),
    );
    return {
      data: {
        providers,
        overrides: overview.overrides,
        changedAt: overview.changedAt,
        reason: overview.reason,
      },
    };
  }

  @Post('mail/:provider/test')
  @HttpCode(202)
  @OpsPermission('providers.manage')
  async startTest(
    @CurrentOps() ops: OpsContext,
    @Param('provider') name: string,
    @Body(new ZodValidationPipe(opsMailTestSchema)) body: OpsMailTestRequest,
  ): Promise<ApiDataResponse<{ testId: string }>> {
    const provider = this.configured(name);
    const to = body.to ?? (await verifiedEmailOf(this.database.db, ops.userId));
    if (!to) throw new CodedHttpException(409, 'EMAIL_VERIFICATION_REQUIRED');
    return {
      data: await startMailProviderTest(this.database.db, this.sealing, {
        staffUserId: ops.userId,
        provider: provider.name,
        to,
        webOrigin: this.config.WEB_ORIGIN,
        reason: body.reason,
      }),
    };
  }

  /** Opened from the test email: any staff member with an ops session may confirm. */
  @Post('tests/confirm')
  @HttpCode(200)
  @OpsPermission('issues.view')
  async confirmTest(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsProviderTestConfirmSchema))
    body: OpsProviderTestConfirmRequest,
  ): Promise<ApiDataResponse<{ outcome: 'confirmed' | 'invalid' }>> {
    return {
      data: {
        outcome: await confirmProviderTest(this.database.db, {
          token: body.token,
          staffUserId: ops.userId,
        }),
      },
    };
  }

  @Post('mail/active')
  @HttpCode(200)
  @OpsPermission('providers.manage')
  async switchProvider(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsMailSwitchSchema))
    body: OpsMailSwitchRequest,
  ): Promise<ApiDataResponse<{ provider: string }>> {
    const provider = this.configured(body.provider);
    const production = this.production();
    const status = await this.statusOf(provider, true);
    // In production a provider whose status can't be read is not switched to blind.
    if (production && !status)
      throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    const outcome = await switchMailProvider(this.database.db, {
      staffUserId: ops.userId,
      provider: provider.name,
      reason: body.reason,
      production,
      sandbox: status?.sandbox ?? null,
      configured: new Set(this.providers.keys()),
      fallback: this.config.MAIL_DEFAULT_PROVIDER,
    });
    if (outcome === 'no_confirmed_test')
      throw new CodedHttpException(409, 'NO_CONFIRMED_TEST');
    if (outcome === 'refused_in_production')
      throw new CodedHttpException(409, 'PROVIDER_NOT_ALLOWED');
    if (outcome === 'not_configured')
      throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: { provider: provider.name } };
  }

  @Post('overrides')
  @HttpCode(200)
  @OpsPermission('providers.manage')
  async setOverride(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsMailOverrideSchema))
    body: OpsMailOverrideRequest,
  ): Promise<ApiDataResponse<{ userId: string }>> {
    const provider = this.configured(body.provider);
    const userId = await findAccountByHandleOrId(
      this.database.db,
      body.account,
    );
    if (!userId) throw new CodedHttpException(404, 'NOT_FOUND');
    // A pinned account's security mail goes through this provider: the same checks as a switch.
    const status = await this.statusOf(provider, true);
    if (this.production()) {
      if (!status) throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
      if (provider.name === 'mock' || status.sandbox === true)
        throw new CodedHttpException(409, 'PROVIDER_NOT_ALLOWED');
    }
    if (
      !(await hasConfirmedMailTest(this.database.db, provider.name, new Date()))
    )
      throw new CodedHttpException(409, 'NO_CONFIRMED_TEST');
    await setProviderOverride(this.database.db, {
      kind: 'mail',
      userId,
      provider: provider.name,
      staffUserId: ops.userId,
      reason: body.reason,
    });
    return { data: { userId } };
  }

  @Post('overrides/remove')
  @HttpCode(200)
  @OpsPermission('providers.manage')
  async removeOverride(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsMailOverrideRemoveSchema))
    body: OpsMailOverrideRemoveRequest,
  ): Promise<ApiDataResponse<{ removed: boolean }>> {
    return {
      data: {
        removed: await removeProviderOverride(this.database.db, {
          kind: 'mail',
          userId: body.userId,
          staffUserId: ops.userId,
          reason: body.reason,
        }),
      },
    };
  }

  /** The address goes in the body so it stays out of access logs. */
  @Post('suppressions/lookup')
  @HttpCode(200)
  @OpsPermission('private.view')
  async lookupSuppression(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsSuppressionLookupSchema))
    body: OpsSuppressionLookupRequest,
  ): Promise<
    ApiDataResponse<{
      suppression: {
        reason: string;
        provider: string | null;
        createdAt: string;
      } | null;
    }>
  > {
    await auditSuppressionLookup(this.database.db, this.sealing, {
      address: body.address,
      staffUserId: ops.userId,
    });
    return {
      data: {
        suppression: await findSuppression(
          this.database.db,
          this.sealing,
          body.address,
        ),
      },
    };
  }

  @Post('suppressions/remove')
  @HttpCode(200)
  @OpsPermission('providers.manage')
  async removeAddressSuppression(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsSuppressionRemoveSchema))
    body: OpsSuppressionRemoveRequest,
  ): Promise<
    ApiDataResponse<{
      outcome: 'removed' | 'not_found' | 'complaint_needs_confirmation';
    }>
  > {
    return {
      data: {
        outcome: await removeSuppression(this.database.db, this.sealing, {
          address: body.address,
          staffUserId: ops.userId,
          reason: body.reason,
          confirmComplaint: body.confirmComplaint,
        }),
      },
    };
  }
}
