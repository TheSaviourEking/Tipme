import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';

/**
 * Whether Page Studio is on. Today this reads PAGE_STUDIO_ENABLED; it moves to the admin switch
 * `page_studio` (feat/admin-switches) once that lands, and only this function changes.
 */
export function pageStudioOn(
  config: Pick<ApiConfig, 'PAGE_STUDIO_ENABLED'>,
): boolean {
  return config.PAGE_STUDIO_ENABLED;
}

/**
 * Page Studio is off until switched on: every Studio route then answers 404 exactly as an unknown
 * path, before any session or rate-limit check, so nothing shows that it exists. Put it first.
 */
@Injectable()
export class StudioEnabledGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(): boolean {
    if (!pageStudioOn(this.config))
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
