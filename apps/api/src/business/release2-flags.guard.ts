import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';

/**
 * Business release 2: the share agreement (and a business's own balance, which only shares fill)
 * is off until `BUSINESS_SHARES_ENABLED=true`. Put it after `BusinessEnabledGuard`: off answers 404
 * exactly as an unknown path.
 */
@Injectable()
export class SharesEnabledGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!this.config.BUSINESS_SHARES_ENABLED)
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}

/** Business release 2: tipping the whole team is off until `TEAM_TIPS_ENABLED=true` (404). */
@Injectable()
export class TeamTipsEnabledGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!this.config.TEAM_TIPS_ENABLED)
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
