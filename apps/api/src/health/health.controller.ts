import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthResponse, ReadinessResponse } from '@tipme/contracts';
import { ReadinessService } from './readiness.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Process liveness only. */
  @Get(['', 'live'])
  @Header('Cache-Control', 'no-store')
  live(): HealthResponse {
    return { status: 'ok', service: 'api' };
  }

  /** Dependency readiness: 503 while Postgres or Redis is unreachable or the API is draining. */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessResponse> {
    const result = await this.readiness.check();
    response.status(result.status === 'ready' ? 200 : 503);
    return result;
  }
}
