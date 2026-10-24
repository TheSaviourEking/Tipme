import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { MeProfileController } from './me-profile.controller.js';
import { PublicProfileController } from './public-profile.controller.js';
import { AvatarController } from './avatar.controller.js';
import { ProfileRevalidator } from './revalidate.js';

@Module({
  controllers: [MeProfileController, PublicProfileController, AvatarController],
  providers: [ProfileRevalidator, SessionGuard, CsrfGuard, RateLimitGuard],
  exports: [ProfileRevalidator],
})
export class ProfilesModule {}
