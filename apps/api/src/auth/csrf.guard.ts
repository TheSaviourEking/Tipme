import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';

/**
 * State-changing requests must come from the web app: its exact Origin plus a custom header,
 * which a cross-site form or image cannot send. GET requests never change anything.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly webOrigin: string;
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.webOrigin = new URL(config.WEB_ORIGIN).origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'GET' || request.method === 'HEAD') return true;
    if (
      request.headers.origin !== this.webOrigin ||
      request.headers['x-tipme-csrf'] !== '1'
    )
      throw new CodedHttpException(403, 'FORBIDDEN_ORIGIN');
    return true;
  }
}
