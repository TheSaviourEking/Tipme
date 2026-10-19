import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  traceProbeRequestSchema,
  type ApiDataResponse,
  type TraceProbeAccepted,
  type TraceProbeRequest,
  type TraceProbeStatus,
} from '@tipme/contracts';
import { z } from 'zod';
import { referenceOf } from '../http/reference.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { TraceProbeQueue } from './trace-probe.queue.js';

/** Development-only probe: proves a request's trace continues into the worker. */
@Controller('v1/diagnostics/trace-probe')
export class DiagnosticsController {
  constructor(private readonly queue: TraceProbeQueue) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async enqueue(
    // `note` is validated then dropped: it never reaches logs, spans or the queue.
    @Body(new ZodValidationPipe(traceProbeRequestSchema))
    body: TraceProbeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<TraceProbeAccepted>> {
    const { jobId } = await this.queue.enqueue(body.mode);
    return { data: { reference: referenceOf(response), jobId } };
  }

  @Get(':jobId')
  @Header('Cache-Control', 'no-store')
  async status(
    @Param('jobId', new ZodValidationPipe(z.uuid())) jobId: string,
  ): Promise<ApiDataResponse<TraceProbeStatus>> {
    const status = await this.queue.status(jobId);
    if (!status) throw new NotFoundException();
    return { data: status };
  }
}
