import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { CodedHttpException } from '../http/coded.exception.js';
import { FeatureSwitches } from '../switches/feature-switches.service.js';

/**
 * Business release 2: the share agreement (and a business's own balance, which only shares fill)
 * is off until the `business_shares` switch is on. Put it after `BusinessEnabledGuard`: off answers 404
 * exactly as an unknown path.
 */
@Injectable()
export class SharesEnabledGuard implements CanActivate {
  constructor(
    @Inject(FeatureSwitches) private readonly switches: FeatureSwitches,
  ) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.switches.on('business_shares')))
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}

/** Business release 2: tipping the whole team is off until the `team_tips` switch is on (404). */
@Injectable()
export class TeamTipsEnabledGuard implements CanActivate {
  constructor(
    @Inject(FeatureSwitches) private readonly switches: FeatureSwitches,
  ) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.switches.on('team_tips')))
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
