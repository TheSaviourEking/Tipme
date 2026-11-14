import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';

/**
 * Business sign-up (Phase D) is off until `BUSINESS_SIGNUP_ENABLED=true`: its routes answer 404
 * exactly as an unknown path. Put it after `BusinessEnabledGuard`.
 */
@Injectable()
export class BusinessSignupEnabledGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!this.config.BUSINESS_SIGNUP_ENABLED)
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
