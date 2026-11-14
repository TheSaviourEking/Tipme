import { Inject, Injectable, type CanActivate } from '@nestjs/common';
import { featureOn } from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';

/**
 * Page Studio is the `page_studio` admin switch (owner, 14 Nov 2026: no variable), off by default.
 * Off: every Studio route answers 404 exactly as an unknown path, before any session or rate-limit
 * check, so nothing shows that it exists. Put it first.
 */
@Injectable()
export class StudioEnabledGuard implements CanActivate {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  async canActivate(): Promise<boolean> {
    if (!(await featureOn(this.database.db, 'page_studio')))
      throw new CodedHttpException(404, 'NOT_FOUND');
    return true;
  }
}
