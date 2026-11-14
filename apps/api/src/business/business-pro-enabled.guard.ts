import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { CodedHttpException } from '../http/coded.exception.js';
import { FeatureSwitches } from '../switches/feature-switches.service.js';

/**
 * Business Pro (plan 2026-11-14-business-pro-and-signup) is off until staff turn on the
 * `business_pro` switch, on top of `business`: a Business Pro route then answers 404 exactly as an
 * unknown path.
 */
@Injectable()
export class BusinessProEnabledGuard implements CanActivate {
  constructor(
    @Inject(FeatureSwitches) private readonly switches: FeatureSwitches,
  ) {}

  async canActivate(): Promise<boolean> {
    const [business, pro] = await Promise.all([
      this.switches.on('business'),
      this.switches.on('business_pro'),
    ]);
    if (!business || !pro) throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
