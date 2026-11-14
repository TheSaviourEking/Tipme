import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';

/**
 * Business Pro (plan 2026-11-14-business-pro-and-signup) is off until `BUSINESS_PRO_ENABLED=true`,
 * on top of `BUSINESS_ENABLED`: a Business Pro route then answers 404 exactly as an unknown path.
 */
@Injectable()
export class BusinessProEnabledGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!this.config.BUSINESS_ENABLED || !this.config.BUSINESS_PRO_ENABLED)
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
