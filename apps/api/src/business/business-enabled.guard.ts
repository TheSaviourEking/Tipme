import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';

/**
 * TipMe for businesses is off until `BUSINESS_ENABLED=true`: every business route then answers
 * 404 exactly as an unknown path, before any session or rate-limit check, so nothing shows that
 * the feature exists. Put it first on each business controller.
 */
@Injectable()
export class BusinessEnabledGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!this.config.BUSINESS_ENABLED)
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
