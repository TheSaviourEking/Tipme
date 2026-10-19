import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller.js';
import { TraceProbeQueue } from './trace-probe.queue.js';

@Module({ controllers: [DiagnosticsController], providers: [TraceProbeQueue] })
export class DiagnosticsModule {}
