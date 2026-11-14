import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { CodedHttpException } from '../http/coded.exception.js';
import { FeatureSwitches } from '../switches/feature-switches.service.js';

/**
 * TipMe for businesses is off until staff turn on the `business` switch: every business route then answers
 * 404 exactly as an unknown path, before any session or rate-limit check, so nothing shows that
 * the feature exists. Put it first on each business controller.
 */
@Injectable()
export class BusinessEnabledGuard implements CanActivate {
  constructor(
    @Inject(FeatureSwitches) private readonly switches: FeatureSwitches,
  ) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.switches.on('business')))
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
