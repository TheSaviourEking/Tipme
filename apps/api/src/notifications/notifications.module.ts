import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { NotificationsController } from './notifications.controller.js';
import { ProfilesModule } from '../profiles/profiles.module.js';

@Module({
  imports: [ProfilesModule],
  controllers: [NotificationsController],
  providers: [SessionGuard, CsrfGuard, RateLimitGuard],
})
export class NotificationsModule {}
