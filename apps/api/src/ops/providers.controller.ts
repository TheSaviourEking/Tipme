import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  mailProviderNameSchema,
  opsMailFailoverSchema,
  opsMailOverrideRemoveSchema,
  opsMailOverrideSchema,
  opsMailSwitchSchema,
  opsMailTestSchema,
  opsProvidersChanged,
  opsProviderTestConfirmSchema,
  opsSuppressionLookupSchema,
  opsSuppressionRemoveSchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsMailFailoverRequest,
  type OpsMailOverrideRemoveRequest,
  type OpsMailOverrideRequest,
  type OpsMailProviders,
  type OpsMailSwitchRequest,
  type OpsMailTestRequest,
  type OpsProviderRetire,
  type OpsSeriousPending,
  type OpsProviderTestConfirmRequest,
  type OpsSuppressionLookupRequest,
  type OpsReasonRequest,
  type OpsSuppressionRemoveRequest,
} from '@tipme/contracts';
import {
  auditSuppressionLookup,
  confirmProviderTest,
  hasConfirmedMailTest,
  findAccountByHandleOrId,
  findSuppression,
  mailProviderOverview,
  recordMailHealthCleared,
  removeProviderOverride,
  setMailFailoverFixed,
  removeSuppression,
  RETIRE_AFTER_MS,
  retireCheck,
  setProviderOverride,
  startMailProviderTest,
  requestSeriousAction,
  type SeriousActionServices,
  verifiedEmailOf,
  type MailSealing,
} from '@tipme/database';
import {
  liveMailProvider,
  mailFailoverGroup,
  type MailHealth,
  type MailHealthView,
  type MailProvider,
  type MailProviderName,
  type MailProviderStatus,
} from '@tipme/mail';
import { API_CONFIG, type ApiConfig } from '../config.js';
import {
  PAYOUT_PROVIDERS_TOKEN,
  type PayoutProviderSet,
} from '../checkout/payment-provider.provider.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import {
  MAIL_HEALTH,
  MAIL_PROVIDERS,
  MAIL_SEALING,
  type MailProviders,
} from '../mail/mail-providers.provider.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { FreshCode } from './fresh-code.guard.js';
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
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(MAIL_HEALTH) private readonly health: MailHealth,
    @Inject(PAYOUT_PROVIDERS_TOKEN)
    private readonly payoutProviders: PayoutProviderSet,
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  /** The providers that stand in for each other; empty or one: no automatic failover. */
  private failoverGroup(): MailProviderName[] {
    const fallbacks = this.config.MAIL_FALLBACK_PROVIDERS ?? [];
    if (fallbacks.length === 0) return [];
    return mailFailoverGroup(
      this.config.MAIL_DEFAULT_PROVIDER,
      fallbacks,
      new Set(this.providers.keys()),
      this.production(),
    );
  }

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

  // Whoever may change the settings has to read them, and open their own test's link.
  @Get('mail')
  @OpsPermission('issues.view', 'providers.manage')
  async overview(): Promise<ApiDataResponse<OpsMailProviders>> {
    const overview = await mailProviderOverview(this.database.db, {
      configured: [...this.providers.keys()],
      fallback: this.config.MAIL_DEFAULT_PROVIDER,
    });
    const group = this.failoverGroup();
    const views: ReadonlyMap<MailProviderName, MailHealthView> | null =
      group.length > 1
        ? await this.health.snapshot([...this.providers.keys()])
        : null;
    const providers = await Promise.all(
      overview.providers.map(async (card) => {
        const status = await this.statusOf(this.providers.get(card.name)!);
        // Only the providers that stand in for each other carry a failover state.
        const view = group.includes(card.name)
          ? views?.get(card.name)
          : undefined;
        return {
          ...card,
          // The map holds the switchable providers only: Brevo only with BREVO_TRANSACTIONAL=on.
          name: card.name as OpsMailProviders['providers'][number]['name'],
          sandbox: status?.sandbox ?? null,
          statusDetail: status?.detail ?? null,
          health: view
            ? {
                state: view.state,
                kind: view.kind,
                until: view.until?.toISOString() ?? null,
                reason: view.reason,
                trippedAt: view.trippedAt?.toISOString() ?? null,
              }
            : null,
        };
      }),
    );
    const active = overview.active;
    const chain = [active, ...group.filter((name) => name !== active)];
    const live =
      views && !overview.fixed ? liveMailProvider(chain, views) : active;
    type Name = OpsMailProviders['failover']['live'];
    return {
      data: {
        providers,
        overrides: overview.overrides,
        changedAt: overview.changedAt,
        reason: overview.reason,
        failover: {
          configured: group.length > 1,
          fixed: overview.fixed,
          live: live as Name,
          backup: (chain[1] ?? null) as Name | null,
        },
      },
    };
  }

  /**
   * Payment providers (per-provider balances, spec §4, §7): each withdraw-only provider's retire
   * check, from TipMe's own records. "Can retire" only at zero, after 30 days quiet.
   */
  @Get('payments/retire')
  @RateLimit('ops_read')
  @OpsPermission('providers.manage')
  async retire(): Promise<ApiDataResponse<OpsProviderRetire>> {
    const rows = await retireCheck(
      this.database.db,
      this.payoutProviders,
      new Date(),
    );
    return {
      data: {
        retireAfterDays: RETIRE_AFTER_MS / 86_400_000,
        providers: rows.map((row) => ({
          ...row,
          lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
        })),
      },
    };
  }

  @Post('mail/:provider/test')
  @HttpCode(202)
  @FreshCode()
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
  @OpsPermission('issues.view', 'providers.manage')
  async confirmTest(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsProviderTestConfirmSchema))
    body: OpsProviderTestConfirmRequest,
  ): Promise<ApiDataResponse<{ outcome: 'confirmed' | 'invalid' }>> {
    const outcome = await confirmProviderTest(this.database.db, {
      token: body.token,
      staffUserId: ops.userId,
    });
    // After the confirm committed: a Providers page waiting on this test reads it again.
    if (outcome === 'confirmed') void this.publishLive(opsProvidersChanged);
    return { data: { outcome } };
  }

  @Post('mail/active')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('providers.manage')
  async switchProvider(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsMailSwitchSchema))
    body: OpsMailSwitchRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<{ provider: string } | OpsSeriousPending>> {
    const provider = this.configured(body.provider);
    const answer = pendingOr<{ provider: string }>(
      await requestSeriousAction(this.database.db, {
        name: 'mail_provider.switch',
        payload: { provider: provider.name },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }

  /**
   * Fix the active provider (no automatic switching, e.g. during an investigation) or let it
   * switch again. Per-person overrides and provider tests never switch either way.
   */
  @Post('mail/failover')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('providers.manage')
  async setFailover(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsMailFailoverSchema))
    body: OpsMailFailoverRequest,
  ): Promise<ApiDataResponse<{ fixed: boolean }>> {
    await setMailFailoverFixed(this.database.db, {
      staffUserId: ops.userId,
      fixed: body.fixed,
      reason: body.reason,
      fallback: this.config.MAIL_DEFAULT_PROVIDER,
    });
    return { data: { fixed: body.fixed } };
  }

  /** Staff clear a tripped provider by hand: it is healthy again at once. */
  @Post('mail/:provider/health/clear')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('providers.manage')
  async clearHealth(
    @CurrentOps() ops: OpsContext,
    @Param('provider') name: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ cleared: boolean }>> {
    const provider = this.configured(name);
    const unavailable = () =>
      new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
    const view = await this.health
      .inspect(provider.name)
      .catch(() => Promise.reject(unavailable()));
    if (view.state === 'healthy') return { data: { cleared: false } };
    // The audit row first: a clear that can't be audited doesn't happen (review, 23 Nov 2026).
    await recordMailHealthCleared(this.database.db, {
      staffUserId: ops.userId,
      provider: provider.name,
      reason: body.reason,
    });
    try {
      await this.health.clear(provider.name);
    } catch {
      throw unavailable();
    }
    void this.publishLive(opsProvidersChanged);
    return { data: { cleared: true } };
  }

  @Post('overrides')
  @HttpCode(200)
  @FreshCode()
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
  @FreshCode()
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
  @FreshCode()
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
  @FreshCode()
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
