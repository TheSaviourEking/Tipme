import { Module } from '@nestjs/common';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { AccountController } from './account.controller.js';
import { AuthController } from './auth.controller.js';
import { RecoveryController } from './recovery.controller.js';
import { CsrfGuard } from './csrf.guard.js';
import { SessionGuard } from './session.guard.js';

@Module({
  controllers: [AuthController, AccountController, RecoveryController],
  providers: [SessionGuard, CsrfGuard, RateLimitGuard],
  exports: [SessionGuard, CsrfGuard],
})
export class AuthModule {}
