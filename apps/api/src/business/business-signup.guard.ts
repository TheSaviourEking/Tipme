import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { CodedHttpException } from '../http/coded.exception.js';
import { FeatureSwitches } from '../switches/feature-switches.service.js';

/**
 * Business sign-up (Phase D) is off until staff turn on the `business_signup` switch: its routes
 * answer 404 exactly as an unknown path. Put it after `BusinessEnabledGuard`.
 */
@Injectable()
export class BusinessSignupEnabledGuard implements CanActivate {
  constructor(
    @Inject(FeatureSwitches) private readonly switches: FeatureSwitches,
  ) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.switches.on('business_signup')))
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
