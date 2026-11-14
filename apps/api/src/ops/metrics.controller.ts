import { Controller, Get, Inject } from '@nestjs/common';
import type {
  ApiDataResponse,
  OpsHealth,
  OpsLiveNow,
  OpsMetricsEnvelope,
  OpsVisibility,
} from '@tipme/contracts';
import { healthMetrics, recordAudit, visibilityMetrics } from '@tipme/database';
import { isLiveProvider } from '@tipme/payments';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/** Health and visibility numbers for staff (permission `analytics.view`, audited). */
@Controller('v1/ops/metrics')
export class OpsMetricsController {
  private readonly collecting: boolean;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {
    this.collecting = config.ANALYTICS_ENABLED;
  }

  @Get('health')
  @OpsPermission('analytics.view')
  async health(
    @CurrentOps() ops: OpsContext,
  ): Promise<ApiDataResponse<OpsMetricsEnvelope<OpsHealth>>> {
    await this.audit(ops, 'health');
    return {
      data: {
        collecting: this.collecting,
        metrics: {
          ...(await healthMetrics(this.database.db, { now: new Date() })),
          liveNow: this.liveNow(),
        },
      },
    };
  }

  private liveNow(): OpsLiveNow {
    const { PAYMENT_PROVIDER, PAYMENTS_LIVE_ENABLED, LIVE_CHECKOUT_HANDLES } =
      this.config;
    const base = {
      live: PAYMENTS_LIVE_ENABLED,
      provider: PAYMENT_PROVIDER,
      handles: [] as string[],
    };
    if (!isLiveProvider(PAYMENT_PROVIDER)) return { ...base, checkout: 'test' };
    if (!PAYMENTS_LIVE_ENABLED) return { ...base, checkout: 'closed' };
    if (LIVE_CHECKOUT_HANDLES === '*') return { ...base, checkout: 'everyone' };
    if (LIVE_CHECKOUT_HANDLES.length === 0)
      return { ...base, checkout: 'nobody' };
    return {
      ...base,
      checkout: 'named',
      handles: [...LIVE_CHECKOUT_HANDLES],
    };
  }

  @Get('visibility')
  @OpsPermission('analytics.view')
  async visibility(
    @CurrentOps() ops: OpsContext,
  ): Promise<ApiDataResponse<OpsMetricsEnvelope<OpsVisibility>>> {
    await this.audit(ops, 'visibility');
    return {
      data: {
        collecting: this.collecting,
        metrics: await visibilityMetrics(this.database.db, {
          now: new Date(),
          days: 28,
        }),
      },
    };
  }

  private audit(ops: OpsContext, view: string) {
    return recordAudit(this.database.db, {
      staffUserId: ops.userId,
      action: 'analytics.viewed',
      permission: 'analytics.view',
      subjectType: 'metrics',
      subjectId: view,
    });
  }
}
