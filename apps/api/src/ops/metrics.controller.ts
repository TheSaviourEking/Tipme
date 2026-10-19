import { Controller, Get, Inject } from '@nestjs/common';
import type {
  ApiDataResponse,
  OpsHealth,
  OpsMetricsEnvelope,
  OpsVisibility,
} from '@tipme/contracts';
import { healthMetrics, recordAudit, visibilityMetrics } from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/** Health and visibility numbers for staff (permission `analytics.view`, audited). */
@Controller('v1/ops/metrics')
export class OpsMetricsController {
  private readonly collecting: boolean;
  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {
    this.collecting =
      config.ANALYTICS_ENABLED ?? config.NODE_ENV !== 'production';
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
        metrics: await healthMetrics(this.database.db, { now: new Date() }),
      },
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
