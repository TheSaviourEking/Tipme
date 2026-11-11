import { Module, type DynamicModule } from '@nestjs/common';
import type { Logger } from '@tipme/observability';
import { API_CONFIG, type ApiConfig } from './config.js';
import { AuthModule } from './auth/auth.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { ProModule } from './pro/pro.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { MomentsModule } from './moments/moments.controller.js';
import { OpsModule } from './ops/ops.module.js';
import { AnalyticsModule } from './analytics/events.controller.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { PretendInboxModule } from './dev/pretend-inbox.controller.js';
import { MockCheckoutModule } from './checkout/mock-checkout.module.js';
import { DiagnosticsModule } from './diagnostics/diagnostics.module.js';
import { HealthController } from './health/health.controller.js';
import { LiveSwitchRecorder } from './health/live-switch.recorder.js';
import { PaymentsHealthController } from './health/payments-health.controller.js';
import {
  ReleaseInfoController,
  ReleaseRunsController,
} from './release/release.controller.js';
import { ReadinessService } from './health/readiness.service.js';
import { InfraModule } from './infra/infra.module.js';
import { MailModule } from './mail/mail.module.js';
import { ChangelogModule } from './changelog/changelog.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { LiveModule } from './live/live.module.js';
import { BusinessModule } from './business/business.module.js';
import { InsightsModule } from './insights/insights.controller.js';

import { LOGGER } from './tokens.js';

export { LOGGER };

@Module({})
export class AppModule {
  static forRoot(config: ApiConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      // Diagnostics routes only exist when explicitly enabled (never in production).
      imports: [
        InfraModule,
        LiveModule,
        CheckoutModule,
        AuthModule,
        ProfilesModule,
        ProModule,
        DashboardModule,
        NotificationsModule,
        MomentsModule,
        OpsModule,
        AnalyticsModule,
        WebhooksModule,
        MailModule,
        BusinessModule,
        ChangelogModule,
        InsightsModule,
        ...(config.PAYMENT_PROVIDER === 'mock' ? [MockCheckoutModule] : []),
        ...(config.MAIL_DEFAULT_PROVIDER === 'mock'
          ? [PretendInboxModule]
          : []),
        ...(config.DIAGNOSTICS_ENABLED ? [DiagnosticsModule] : []),
      ],
      controllers: [
        HealthController,
        PaymentsHealthController,
        ReleaseInfoController,
        ReleaseRunsController,
      ],
      providers: [
        ReadinessService,
        LiveSwitchRecorder,
        { provide: API_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
      ],
      exports: [API_CONFIG, LOGGER, ReadinessService],
      global: true,
    };
  }
}
