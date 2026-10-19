import { Module } from '@nestjs/common';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { AuthController } from './auth.controller.js';
import { CsrfGuard } from './csrf.guard.js';
import { SessionGuard } from './session.guard.js';

@Module({
  controllers: [AuthController],
  providers: [SessionGuard, CsrfGuard, RateLimitGuard],
  exports: [SessionGuard, CsrfGuard],
})
export class AuthModule {}
